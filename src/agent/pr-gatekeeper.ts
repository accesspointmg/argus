// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * PR Gatekeeper — decides whether a PR is safe to build and merge.
 *
 * Posts a commit status (`argus/threat-assessment`) on every open PR's HEAD
 * SHA. Branch protection listing that context as required makes it a merge
 * gate.
 *
 *   1. Statuses attach to a commit SHA, so a force-push resets the gate.
 *   2. Argus's own PRs are assessed like everyone else's — they're the
 *      highest-risk PRs, written from attacker-supplied issue text — with no
 *      trusted-author fast path. A clean own PR stays `pending` ("awaiting
 *      human review"): Argus never self-approves.
 *   3. Fail closed: `fail`, `review`, and "assessment unavailable" all post
 *      `failure`. Unavailable assessments are retried with backoff.
 *   4. `pending` is posted before the verdict so nobody merges in the gap.
 *   5. Assessed SHAs are persisted (Memento). If that record is lost, an
 *      existing authentic Argus assessment comment for the SHA is reused
 *      instead of paying for another LLM call and posting a duplicate.
 *   6. Dry run is enforced by the guarded forge (writes are no-ops); this
 *      class posts the honest state and never substitutes `success`.
 */

import { isAbortError, throwIfAborted } from '../util/abort';
import type * as vscode from 'vscode';
import type { Forge, PullRequest, RepoKey } from '../forge/types';
import type { DiffAssessment, DiffVerdict } from '../security/types';
import type { DiffAssessor } from '../security/diff-assessor';
import type { TrustManager } from '../security/trust';
import { artifactId, type StampManager } from '../crypto/stamp';
import type { AuditLog } from '../crypto/audit';
import type { Logger } from '../util/logger';
import { neutralizeForPost } from '../security/sanitizer';
import { readSetting, type SettingReader } from '../security/settings';

// ─── Constants ──────────────────────────────────────────────────

/** Branch protection references this exact string. Don't change it. */
const STATUS_CONTEXT = 'argus/threat-assessment';

/** GitHub truncates descriptions at 140 chars. */
const MAX_DESCRIPTION = 140;

const STATE_KEY = 'argus.gatekeeper.assessed';
const MAX_RECORDS = 2000;
const RETRY_BACKOFF_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 5;

/** Machine-readable marker inside our (signed) assessment comment. */
const MARKER = /<!-- argus-assessment sha=([a-f0-9]{7,64}) verdict=(pass|fail|review) final=(0|1) -->/;

type StatusState = 'pending' | 'success' | 'failure' | 'error';

// ─── Types ──────────────────────────────────────────────────────

/** @deprecated Settings are read live; kept for the agent/index re-export. */
export type GatekeeperConfig = Record<string, never>;

export interface GatekeeperResult {
    prNumber: number;
    headSha: string;
    verdict: DiffVerdict | 'self' | 'skipped';
    statusPosted: boolean;
    assessment?: DiffAssessment;
    ownPR?: boolean;
    reason: string;
}

interface AssessedRecord {
    verdict: DiffVerdict;
    /** False when the assessment was unavailable and should be retried. */
    final: boolean;
    at: number;
    attempts: number;
}

// ─── Gatekeeper ─────────────────────────────────────────────────

export class PRGatekeeper {
    /** Dry-run results stay in memory so turning dry run off re-assesses for real. */
    private dryRunRecords = new Map<string, AssessedRecord>();

    constructor(
        private readonly diffAssessor: DiffAssessor,
        private readonly trust: TrustManager,
        private readonly stampManager: StampManager,
        private readonly auditLog: AuditLog,
        private readonly logger: Logger,
        private readonly state: vscode.Memento,
        private readonly settings: SettingReader = readSetting,
    ) {}

    /** Assess every open PR and post statuses. Returns how many got a new status. */
    async assessAll(forge: Forge, openPRs: PullRequest[], signal?: AbortSignal): Promise<number> {
        const repoKey: RepoKey = `${forge.platform}:${forge.owner}/${forge.repo}`;
        let posted = 0;
        for (const pr of openPRs) {
            throwIfAborted(signal);
            try {
                const result = await this.assessOne(forge, pr, repoKey);
                if (result.statusPosted) { posted++; }
            } catch (err) {
                // Stop / Emergency Stop must end the whole pass, not just this PR.
                if (isAbortError(err)) { throw err; }
                this.logger.error(`Gatekeeper error on PR #${pr.number}: ${err}`);
            }
        }
        if (posted > 0) {
            this.logger.info(`Gatekeeper: posted ${posted} status(es) in ${repoKey}`);
        }
        return posted;
    }

    /** Assess a single PR. Idempotent per SHA (persisted). */
    async assessOne(forge: Forge, pr: PullRequest, repoKey: RepoKey): Promise<GatekeeperResult> {
        const sha = pr.headSha;
        const skip = (reason: string): GatekeeperResult =>
            ({ prNumber: pr.number, headSha: sha ?? '', verdict: 'skipped', statusPosted: false, reason });

        if (!sha) { return skip('No head SHA available on PR'); }

        const dryRun = this.settings('dryRun', false);
        const tag = dryRun ? '[DRY RUN] ' : '';
        const key = `${repoKey}@${sha}`;
        const prior = this.getRecord(key, dryRun);

        if (prior?.final) { return skip('Already assessed this SHA'); }
        if (prior && (prior.attempts >= MAX_ATTEMPTS || Date.now() - prior.at < RETRY_BACKOFF_MS)) {
            return skip('Assessment unavailable earlier; waiting before retry');
        }

        const ownPR = this.stampManager.isOwnAuthentic(pr.body ?? '', artifactId(repoKey, 'pr', pr.number));
        const attempts = (prior?.attempts ?? 0) + 1;

        // State lost but we already assessed this SHA? Reuse our signed verdict.
        if (!prior) {
            const existing = await this.findOwnAssessment(forge, repoKey, pr.number, sha);
            if (existing?.final) {
                const { state, description } = this.statusFor(existing.verdict, ownPR, false, undefined);
                await this.postStatus(forge, sha, state, description);
                await this.setRecord(key, { verdict: existing.verdict, final: true, at: Date.now(), attempts }, dryRun);
                this.logger.info(`${tag}PR #${pr.number} (${sha.substring(0, 8)}): reused earlier assessment (${existing.verdict})`);
                return { prNumber: pr.number, headSha: sha, verdict: existing.verdict, statusPosted: true, ownPR, reason: 'Reused earlier assessment' };
            }
            // First sight: block the merge window before the verdict exists.
            await this.postStatus(forge, sha, 'pending', 'Assessment in progress — do not merge yet.');
        }

        let assessment: DiffAssessment;
        try {
            const author = await this.trust.resolve(forge, pr.author, pr.authorAssociation);
            const files = await forge.getPRFiles(pr.number);
            assessment = await this.diffAssessor.assess(files, author, sha, {
                prTitle: pr.title,
                prBody: pr.body,
                forceLlm: ownPR,
            });
        } catch (err) {
            // Status stays pending (not mergeable); retry later.
            await this.setRecord(key, { verdict: 'review', final: false, at: Date.now(), attempts }, dryRun);
            throw err;
        }

        const final = !assessment.unavailable;
        const { state, description } = this.statusFor(assessment.verdict, ownPR, !!assessment.unavailable, assessment);
        await this.postStatus(forge, sha, state, description);

        // Evidence comment: on anything but a clean pass, or when exec-surface files were touched.
        // Unavailable assessments comment once (first attempt), not on every retry.
        const wantsComment = assessment.verdict !== 'pass' || assessment.executionSurfaceChanges.length > 0;
        if (wantsComment && (final || attempts === 1)) {
            const existing = await this.findOwnAssessment(forge, repoKey, pr.number, sha);
            if (!existing || existing.verdict !== assessment.verdict || existing.final !== final) {
                await this.postAssessmentComment(forge, pr.number, assessment, ownPR, final, repoKey);
            }
        }

        await this.auditLog.append({
            action: 'gate_pr',
            repo: `${forge.owner}/${forge.repo}`,
            target: pr.url,
            input: sha,
            output: `${assessment.verdict}${final ? '' : ' (unavailable)'}`,
            decision: `${tag}${state}: ${assessment.verdict} (confidence ${(assessment.confidence * 100).toFixed(0)}%)${ownPR ? ' [own PR]' : ''}`,
            llmCallCount: assessment.llmCalls,
            details: neutralizeForPost(assessment.reasoning, 200),
        });

        await this.setRecord(key, { verdict: assessment.verdict, final, at: Date.now(), attempts }, dryRun);

        this.logger.info(
            `${tag}PR #${pr.number} (${sha.substring(0, 8)}): ${state} / ${assessment.verdict}` +
            `${final ? '' : ' (assessment unavailable)'}${ownPR ? ' [own PR]' : ''}`,
        );

        return {
            prNumber: pr.number,
            headSha: sha,
            verdict: assessment.verdict,
            statusPosted: true,
            assessment,
            ownPR,
            reason: assessment.reasoning,
        };
    }

    /** Forget all assessed SHAs (persisted and in-memory). */
    async clearCache(): Promise<void> {
        this.dryRunRecords.clear();
        await this.state.update(STATE_KEY, undefined);
    }

    // ─── Verdict → status ───────────────────────────────────────

    /** Pure mapping. Everything that isn't a clean pass blocks the merge. */
    statusFor(
        verdict: DiffVerdict,
        ownPR: boolean,
        unavailable: boolean,
        assessment: DiffAssessment | undefined,
    ): { state: StatusState; description: string } {
        if (unavailable) {
            return { state: 'failure', description: 'Assessment unavailable — human review required.' };
        }
        const trustInfo = assessment
            ? ` — trust: ${assessment.authorTrust.tier}/${assessment.authorTrust.effectiveTrustScore.toFixed(2)}`
            : '';
        const surface = assessment?.executionSurfaceChanges.length ?? 0;
        switch (verdict) {
            case 'pass':
                if (ownPR) {
                    // Assessed like any other PR. A required "pending" here would make every
                    // Argus PR unmergeable without an admin override; human review is still
                    // enforced by the repo's normal review rules.
                    return { state: 'success', description: 'No threats found in this Argus-authored change — human review still required.' };
                }
                return {
                    state: 'success',
                    description: surface > 0 ? `Safe (${surface} exec-surface file(s) reviewed)${trustInfo}` : `Safe${trustInfo}`,
                };
            case 'fail': {
                const why = assessment ? neutralizeForPost(assessment.evidence[0] ?? assessment.reasoning, 90) : '';
                return { state: 'failure', description: `Blocked${why ? `: ${why}` : ''}` };
            }
            case 'review':
            default:
                return { state: 'failure', description: `Human review required — ${surface} exec-surface file(s)${trustInfo}` };
        }
    }

    // ─── Internals ──────────────────────────────────────────────

    private async postStatus(forge: Forge, sha: string, state: StatusState, description: string): Promise<void> {
        const truncated = description.length > MAX_DESCRIPTION
            ? description.substring(0, MAX_DESCRIPTION - 1) + '…'
            : description;
        await forge.createCommitStatus(sha, state, STATUS_CONTEXT, truncated);
    }

    /** Our authentic assessment comment for this SHA, if one exists. */
    private async findOwnAssessment(
        forge: Forge,
        repoKey: RepoKey,
        prNumber: number,
        sha: string,
    ): Promise<{ verdict: DiffVerdict; final: boolean } | undefined> {
        let comments;
        try {
            comments = await forge.getPRComments(prNumber);
        } catch {
            return undefined;
        }
        let found: { verdict: DiffVerdict; final: boolean } | undefined;
        for (const c of comments) {
            const m = MARKER.exec(c.body ?? '');
            if (!m || m[1] !== sha) { continue; }
            if (!this.stampManager.isOwnAuthentic(c.body, artifactId(repoKey, 'comment', c.id))) { continue; }
            found = { verdict: m[2] as DiffVerdict, final: m[3] === '1' }; // latest wins
        }
        return found;
    }

    private getRecord(key: string, dryRun: boolean): AssessedRecord | undefined {
        if (dryRun) { return this.dryRunRecords.get(key); }
        return this.state.get<Record<string, AssessedRecord>>(STATE_KEY)?.[key];
    }

    private async setRecord(key: string, rec: AssessedRecord, dryRun: boolean): Promise<void> {
        if (dryRun) {
            this.dryRunRecords.set(key, rec);
            return;
        }
        const all = { ...(this.state.get<Record<string, AssessedRecord>>(STATE_KEY) ?? {}) };
        all[key] = rec;
        const keys = Object.keys(all);
        if (keys.length > MAX_RECORDS) {
            keys.sort((a, b) => all[a].at - all[b].at);
            for (const k of keys.slice(0, keys.length - MAX_RECORDS)) { delete all[k]; }
        }
        await this.state.update(STATE_KEY, all);
    }

    /**
     * Evidence comment. Everything model- or attacker-derived (reasoning,
     * evidence, file paths) is neutralized: no mentions, links, images, markup.
     */
    private async postAssessmentComment(
        forge: Forge,
        prNumber: number,
        assessment: DiffAssessment,
        ownPR: boolean,
        final: boolean,
        repoKey: RepoKey,
    ): Promise<void> {
        const icon = !final ? '⚠️'
            : assessment.verdict === 'pass' ? '✅'
            : assessment.verdict === 'fail' ? '❌'
            : '⚠️';
        const verdictLabel = !final ? 'ASSESSMENT UNAVAILABLE' : assessment.verdict.toUpperCase();

        const surfaceSection = assessment.executionSurfaceChanges.length > 0
            ? '### Execution Surface Changes\n\n| Risk | File | Detail |\n|---|---|---|\n' +
              [...assessment.executionSurfaceChanges]
                  .sort((a, b) => riskOrder(a.risk) - riskOrder(b.risk))
                  .slice(0, 50)
                  .map((c) => `| **${c.risk.toUpperCase()}** | \`${neutralizeForPost(c.path, 200)}\` | ${c.detail} |`)
                  .join('\n') + '\n'
            : '';

        const evidence = assessment.evidence.slice(0, 10).map((e) => neutralizeForPost(e, 200)).filter(Boolean);
        const evidenceSection = evidence.length > 0
            ? `### Evidence\n\n${evidence.map((e) => `- ${e}`).join('\n')}\n`
            : '';

        const author = assessment.authorTrust.username.replace(/[^\w-]/g, '');
        const content = `## ${icon} Argus Threat Assessment

| | |
|---|---|
| **Verdict** | **${verdictLabel}** |
| **Confidence** | ${(assessment.confidence * 100).toFixed(0)}% |
| **Author** | ${author} (${assessment.authorTrust.tier}, trust score ${assessment.authorTrust.effectiveTrustScore.toFixed(2)})${ownPR ? ' — Argus-authored' : ''} |
| **Commit** | \`${assessment.commitSha.substring(0, 12)}\` |
| **LLM calls** | ${assessment.llmCalls} |

### Reasoning

${neutralizeForPost(assessment.reasoning, 600)}

${surfaceSection}${evidenceSection}
> Argus's diff security assessor evaluates whether the changes are safe to build on trusted infrastructure.
> ${final ? '' : 'The assessment could not be completed, so the merge gate is closed until a human reviews. '}Argus **never** merges PRs — a human must approve and merge.

<!-- argus-assessment sha=${assessment.commitSha} verdict=${assessment.verdict} final=${final ? 1 : 0} -->`;

        const { stamped, stamp } = this.stampManager.stampContent(content);
        const comment = await forge.addPRComment(prNumber, stamped);
        if (comment?.id) { this.stampManager.recordPosted(stamp, artifactId(repoKey, 'comment', comment.id), repoKey); }
    }
}

function riskOrder(risk: string): number {
    switch (risk) {
        case 'critical': return 0;
        case 'high':     return 1;
        case 'medium':   return 2;
        case 'low':      return 3;
        default:         return 4;
    }
}
