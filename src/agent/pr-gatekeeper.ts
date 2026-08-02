// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * PR Gatekeeper — decides whether a PR is safe to build and merge.
 *
 * Posts a commit status (`argus/threat-assessment`) on every open PR's HEAD
 * SHA.  Branch protection rules listing that context as required turn this
 * into a hard merge gate: nothing lands without a green verdict.
 *
 * Design principles:
 *
 *   1. **Statuses attach to a commit SHA.**  A force-push lands on a new SHA
 *      with no status, so the gate resets automatically.  This is the
 *      EditDetector bait-and-switch problem solving itself — no head-SHA
 *      tracking is needed.
 *
 *   2. **Argus never self-approves.**  PRs authored by this Argus instance
 *      get a `pending` status with "awaiting human review — Argus does not
 *      self-approve."  The seller must merge; Argus never merges.
 *
 *   3. **Fast paths skip the LLM.**  Trusted author + no execution-surface
 *      changes = instant `success`.  Untrusted author + critical surface
 *      changes = instant `failure`.  The LLM is only invoked in the middle
 *      band.  This keeps cost proportional to risk and avoids the offline
 *      deadlock for trusted authors' own PRs.
 *
 *   4. **`pending` before verdict.**  The instant Argus first sees an
 *      unassessed PR it posts `pending` ("assessment in progress").  This
 *      artifact exists even before the LLM returns, so a human cannot
 *      approve-and-merge in the gap.
 *
 *   5. **Portable.**  Uses `createCommitStatus()` (works on GitHub and
 *      GitLab) rather than the Checks API (GitHub-App-only).  A future
 *      GitHub App upgrade adds line annotations as enrichment, not as a
 *      replacement.
 */

import type { Forge, PullRequest, RepoKey } from '../forge/types';
import type { DiffAssessment, DiffVerdict } from '../security/types';
import type { DiffAssessor } from '../security/diff-assessor';
import type { TrustResolver } from '../security/trust';
import type { StampManager } from '../crypto/stamp';
import type { AuditLog } from '../crypto/audit';
import type { Logger } from '../util/logger';

// ─── Constants ──────────────────────────────────────────────────

/**
 * The commit-status context name.  Branch protection rules reference this
 * exact string, so changing it breaks every repo that lists it as required.
 */
const STATUS_CONTEXT = 'argus/threat-assessment';

/** Description ceiling — GitHub truncates at 140 chars. */
const MAX_DESCRIPTION = 140;

// ─── Types ──────────────────────────────────────────────────────

export interface GatekeeperConfig {
    /** Post statuses but never `failure` — advisory mode. */
    dryRun: boolean;
    /**
     * Whether PRs from trusted authors (score >= autoPassThreshold) that
     * touch no execution surface should get an instant `success` without
     * an LLM call.  Cheaper, faster, avoids the offline deadlock for the
     * repo owner's own work — at the cost of not reading their diffs.
     */
    fastPathTrustedAuthors: boolean;
    /** Trust score at or above which the fast path applies. */
    autoPassThreshold: number;
}

const DEFAULT_CONFIG: GatekeeperConfig = {
    dryRun: false,
    fastPathTrustedAuthors: true,
    autoPassThreshold: 0.5,
};

export interface GatekeeperResult {
    prNumber: number;
    headSha: string;
    verdict: DiffVerdict | 'self' | 'skipped';
    statusPosted: boolean;
    assessment?: DiffAssessment;
    reason: string;
}

// ─── Gatekeeper ─────────────────────────────────────────────────

export class PRGatekeeper {
    private readonly config: GatekeeperConfig;

    /**
     * SHAs we have already posted a final (non-pending) status for during
     * this session.  Prevents re-assessing the same commit on every poll.
     * Cleared on force-push automatically because the SHA changes.
     */
    private assessed = new Set<string>();

    constructor(
        private readonly diffAssessor: DiffAssessor,
        private readonly trustResolver: TrustResolver,
        private readonly stampManager: StampManager,
        private readonly auditLog: AuditLog,
        private readonly logger: Logger,
        config?: Partial<GatekeeperConfig>,
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Assess every open PR in a repo and post commit statuses.
     *
     * Intended to be called from the poll cycle alongside `pollPRComments`.
     * Returns the number of PRs that received a new status.
     */
    async assessAll(forge: Forge, openPRs: PullRequest[]): Promise<number> {
        const repoKey: RepoKey = `${forge.platform}:${forge.owner}/${forge.repo}`;
        let posted = 0;

        for (const pr of openPRs) {
            try {
                const result = await this.assessOne(forge, pr, repoKey);
                if (result.statusPosted) { posted++; }
            } catch (err) {
                this.logger.error(`Gatekeeper error on PR #${pr.number}: ${err}`);
            }
        }

        if (posted > 0) {
            this.logger.info(
                `Gatekeeper: posted ${posted} status(es) in ${repoKey}`,
            );
        }

        return posted;
    }

    /**
     * Assess a single PR. Idempotent per SHA — if we've already posted a
     * final status for this SHA, returns immediately.
     */
    async assessOne(
        forge: Forge,
        pr: PullRequest,
        repoKey: RepoKey,
    ): Promise<GatekeeperResult> {
        const sha = pr.headSha;

        // No SHA available (shouldn't happen, but defensive)
        if (!sha) {
            return {
                prNumber: pr.number,
                headSha: '',
                verdict: 'skipped',
                statusPosted: false,
                reason: 'No head SHA available on PR',
            };
        }

        // Already assessed this exact SHA
        if (this.assessed.has(sha)) {
            return {
                prNumber: pr.number,
                headSha: sha,
                verdict: 'skipped',
                statusPosted: false,
                reason: 'Already assessed this SHA',
            };
        }

        // ── Self-assessment guard ──
        // Argus's own PRs are never self-approved.
        if (this.isOurPR(pr)) {
            await this.postStatus(forge, sha, 'pending',
                'Awaiting human review \u2014 Argus does not self-approve.');
            this.assessed.add(sha);

            this.logger.info(
                `PR #${pr.number}: self-authored \u2014 posted pending, not self-approving`,
            );

            return {
                prNumber: pr.number,
                headSha: sha,
                verdict: 'self',
                statusPosted: true,
                reason: 'Self-authored PR \u2014 awaiting human review',
            };
        }

        // ── Post pending immediately ──
        // This closes the window between "Argus sees the PR" and "Argus
        // finishes assessing" — the status exists before the verdict.
        await this.postStatus(forge, sha, 'pending',
            'Assessment in progress \u2014 do not merge yet.');

        // ── Resolve author trust ──
        const author = await this.trustResolver.resolve(forge, pr.author);

        // ── Get files ──
        const files = await forge.getPRFiles(pr.number);

        // ── Run the diff assessor ──
        const assessment = await this.diffAssessor.assess(files, author, sha);

        // ── Map verdict to status ──
        const state = this.verdictToState(assessment.verdict);
        const description = this.buildDescription(assessment);

        if (this.config.dryRun && state === 'failure') {
            // Advisory mode: post success with a note
            await this.postStatus(forge, sha, 'success',
                `[DRY RUN] Would have blocked: ${description}`);
        } else {
            await this.postStatus(forge, sha, state, description);
        }

        // ── Post a comment with the evidence ──
        if (assessment.verdict !== 'pass' || assessment.executionSurfaceChanges.length > 0) {
            await this.postAssessmentComment(forge, pr.number, assessment);
        }

        // ── Audit ──
        await this.auditLog.append({
            action: 'gate_pr',
            repo: `${forge.owner}/${forge.repo}`,
            target: pr.url,
            input: sha,
            output: assessment.verdict,
            decision: `${assessment.verdict} (confidence ${(assessment.confidence * 100).toFixed(0)}%)`,
            llmCallCount: assessment.llmCalls,
            details: assessment.reasoning.substring(0, 200),
        });

        this.assessed.add(sha);

        this.logger.info(
            `PR #${pr.number} (${sha.substring(0, 8)}): ` +
            `${assessment.verdict} \u2014 ${assessment.reasoning.substring(0, 120)}`,
        );

        return {
            prNumber: pr.number,
            headSha: sha,
            verdict: assessment.verdict,
            statusPosted: true,
            assessment,
            reason: assessment.reasoning,
        };
    }

    /**
     * Clear the assessed cache. Useful on config change or manual reset.
     */
    clearCache(): void {
        this.assessed.clear();
    }

    // ─── Internals ──────────────────────────────────────────────

    /** Post a commit status via the forge. */
    private async postStatus(
        forge: Forge,
        sha: string,
        state: 'pending' | 'success' | 'failure' | 'error',
        description: string,
    ): Promise<void> {
        const truncated = description.length > MAX_DESCRIPTION
            ? description.substring(0, MAX_DESCRIPTION - 1) + '\u2026'
            : description;

        await forge.createCommitStatus(sha, state, STATUS_CONTEXT, truncated);
    }

    /** Map a DiffVerdict to a commit-status state. */
    private verdictToState(verdict: DiffVerdict): 'success' | 'failure' | 'pending' {
        switch (verdict) {
            case 'pass':   return 'success';
            case 'fail':   return 'failure';
            case 'review': return 'pending';
        }
    }

    /** Build a human-readable status description. */
    private buildDescription(assessment: DiffAssessment): string {
        const trustInfo = `${assessment.authorTrust.tier}/${assessment.authorTrust.effectiveTrustScore.toFixed(2)}`;
        const surfaceCount = assessment.executionSurfaceChanges.length;

        switch (assessment.verdict) {
            case 'pass':
                return surfaceCount > 0
                    ? `Safe (${surfaceCount} exec-surface file(s) reviewed) \u2014 trust: ${trustInfo}`
                    : `Safe \u2014 trust: ${trustInfo}`;
            case 'fail':
                return `Blocked: ${assessment.evidence[0] || assessment.reasoning.substring(0, 80)}`;
            case 'review':
                return `Human review required \u2014 ${surfaceCount} exec-surface file(s), trust: ${trustInfo}`;
        }
    }

    /** Whether a PR was authored by this Argus instance. */
    private isOurPR(pr: PullRequest): boolean {
        if (!pr.body) { return false; }
        const shortId = this.stampManager.extractInstanceId(pr.body);
        return shortId !== null && this.stampManager.instanceId.startsWith(shortId);
    }

    /**
     * Post a structured comment on the PR summarizing the assessment.
     *
     * Only posted when the verdict is not a clean pass, or when
     * execution-surface files were detected (even if passed).
     */
    private async postAssessmentComment(
        forge: Forge,
        prNumber: number,
        assessment: DiffAssessment,
    ): Promise<void> {
        const icon = assessment.verdict === 'pass' ? '\u2705'
            : assessment.verdict === 'fail' ? '\u274C'
            : '\u26A0\uFE0F';

        const surfaceSection = assessment.executionSurfaceChanges.length > 0
            ? `### Execution Surface Changes\n\n` +
              `| Risk | File | Detail |\n|---|---|---|\n` +
              assessment.executionSurfaceChanges
                  .sort((a, b) => riskOrder(a.risk) - riskOrder(b.risk))
                  .map((c) => `| **${c.risk.toUpperCase()}** | \`${c.path}\` | ${c.detail} |`)
                  .join('\n') +
              '\n'
            : '';

        const evidenceSection = assessment.evidence.length > 0
            ? `### Evidence\n\n${assessment.evidence.map((e) => `- ${e}`).join('\n')}\n`
            : '';

        const content = `## ${icon} Argus Threat Assessment

| | |
|---|---|
| **Verdict** | **${assessment.verdict.toUpperCase()}** |
| **Confidence** | ${(assessment.confidence * 100).toFixed(0)}% |
| **Author** | @${assessment.authorTrust.username} (${assessment.authorTrust.tier}, trust score ${assessment.authorTrust.effectiveTrustScore.toFixed(2)}) |
| **Commit** | \`${assessment.commitSha.substring(0, 8)}\` |
| **LLM calls** | ${assessment.llmCalls} |

### Reasoning

${assessment.reasoning}

${surfaceSection}${evidenceSection}
> This assessment was performed by Argus's diff security assessor.
> It evaluates whether the changes are safe to build on trusted infrastructure.
> Argus **never** merges PRs \u2014 a human must approve and merge.`;

        const { stamped } = this.stampManager.stampContent(content);
        await forge.addPRComment(prNumber, stamped);
    }
}

/** Sort helper: critical first. */
function riskOrder(risk: string): number {
    switch (risk) {
        case 'critical': return 0;
        case 'high':     return 1;
        case 'medium':   return 2;
        case 'low':      return 3;
        default:         return 4;
    }
}
