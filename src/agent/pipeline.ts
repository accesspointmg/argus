// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * RepoPipeline — everything Argus does for one repository, one cycle at a time.
 *
 * A cycle:
 *   1. poll issues updated since the last cycle and enqueue new ones;
 *   2. review open PRs (merge-gate assessment; feedback and loop detection on
 *      Argus's own PRs);
 *   3. moderate new comments on issues Argus has PRs for;
 *   4. process the next queued issue: evaluate → trust gate → branch →
 *      investigate → code → PR.
 *
 * Invariants:
 *   - One cycle per repo at a time (`running` lock); the controller schedules
 *     the next cycle only after the previous one ends.
 *   - State is persisted (see StateStore), and processing is idempotent: an
 *     existing Argus PR or branch for an issue is reused, never duplicated.
 *   - Code is only written for issues whose author is trusted, or after a
 *     trusted user comments `/argus fix`. Everyone else gets triage labels.
 *   - Settings are read at the start of each cycle, so changes apply without a
 *     restart. Dry run and halting are enforced again by the GuardedForge.
 */

import { createHash } from 'crypto';
import * as vscode from 'vscode';
import type { Comment, Forge, Issue, PullRequest, RepoConfig, RepoKey, ReviewComment } from '../forge/types';
import { repoKey as toRepoKey } from '../forge/types';
import type { CodingIteration, IssueEvaluation, TrackedIssue } from './types';
import type { Evaluator } from './evaluator';
import type { Investigator } from './investigator';
import type { Coder } from './coder';
import type { Transcriber } from './transcriber';
import type { CommentHandler } from './comment-handler';
import type { EditDetector } from './edit-detector';
import type { PRAnalyzer } from './pr-analyzer';
import type { PRGatekeeper } from './pr-gatekeeper';
import { LoopDetector } from './loop-detector';
import { EngagementPolicy } from './engagement';
import type { StateStore, RepoState } from './state-store';
import { ACTIVE_STATES } from './state-store';
import type { StampManager } from '../crypto/stamp';
import { artifactId } from '../crypto/stamp';
import { resolveOwnership } from '../security/sovereignty';
import type { AuditLog } from '../crypto/audit';
import type { Sanitizer } from '../security/sanitizer';
import type { TrustManager } from '../security/trust';
import type { NotificationRouter } from '../notifications/events';
import type { Logger } from '../util/logger';
import type { ArgusConfig } from '../util/config';
import { readConfig } from '../util/config';
import { isAbortError, linkedController, throwIfAborted } from '../util/abort';
import { inlineCode, neutralizeModelText, oneLine } from '../util/text';

// ─── Dependencies ───────────────────────────────────────────────

/** Bounds how many issues are in active processing across all repos. */
export interface WorkSlots {
    tryAcquire(): boolean;
    release(): void;
}

export interface PipelineDeps {
    evaluator: Evaluator;
    investigator: Investigator;
    coder: Coder;
    transcriber: Transcriber;
    commentHandler: CommentHandler;
    editDetector: EditDetector;
    prAnalyzer: PRAnalyzer;
    gatekeeper: PRGatekeeper;
    stampManager: StampManager;
    auditLog: AuditLog;
    sanitizer: Sanitizer;
    trust: TrustManager;
    notifier: NotificationRouter;
    store: StateStore;
    slots: WorkSlots;
    /** Writes of a kind still allowed by `argus.rateLimits.*` right now. */
    writeBudget: (kind: 'branch' | 'push' | 'pr' | 'comment') => number;
    logger: Logger;
}

// ─── Constants ──────────────────────────────────────────────────

/** First poll looks back this far. */
const INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Acknowledgements per PR per window, so Argus can't be drawn into a conversation loop. */
const MAX_ACKS_PER_PR = 3;
const ACK_WINDOW_MS = 2 * 60 * 60 * 1000;
/** A trusted user comments this to authorize code generation for an untrusted author's issue. */
const APPROVAL_COMMAND = /^\s*\/argus\s+(fix|approve|go)\b/im;
/** Low-confidence rejections go to a human instead of being closed out. */
const REJECT_CONFIDENCE = 0.7;

/** Bot conversation comments that carry no feedback (e.g. "I've opened a new pull request"). */
const BOT_NOISE_PATTERNS: RegExp[] = [
    /I've opened a new pull request/i,
    /I'll request review from you/i,
    /I was blocked by some firewall rules/i,
    /Once the pull request is ready/i,
];

function isBotNoise(author: string, body: string): boolean {
    return author.toLowerCase().endsWith('[bot]') && BOT_NOISE_PATTERNS.some((p) => p.test(body));
}

function isWorkInProgress(pr: PullRequest): boolean {
    if (pr.draft) { return true; }
    const upper = pr.title.trim().toUpperCase();
    return ['[WIP]', 'WIP:', 'WIP ', 'DRAFT:', '[DRAFT]'].some((p) => upper.startsWith(p)) || pr.title.includes('🚧');
}


export interface CycleResult {
    skipped?: boolean;
    enqueued: number;
    processed?: TrackedIssue;
}

// ─── Pipeline ───────────────────────────────────────────────────

export class RepoPipeline {
    readonly key: RepoKey;
    private running = false;
    private readonly loopDetector: LoopDetector;

    constructor(
        readonly repo: RepoConfig,
        private readonly forge: Forge,
        private readonly deps: PipelineDeps,
    ) {
        this.key = toRepoKey(repo);
        this.loopDetector = new LoopDetector(deps.stampManager, deps.logger);
    }

    get isRunning(): boolean {
        return this.running;
    }

    getQueue(): readonly TrackedIssue[] {
        return this.state.queue;
    }

    private get state(): RepoState {
        return this.deps.store.get(this.key);
    }

    private get log(): Logger {
        return this.deps.logger;
    }

    /** Run one full cycle. Returns immediately (skipped) if a cycle is already running. */
    async runCycle(signal: AbortSignal): Promise<CycleResult> {
        if (this.running) {
            return { skipped: true, enqueued: 0 };
        }
        this.running = true;
        try {
            const cfg = readConfig();
            const updated = await this.pollIssues(cfg, signal);
            throwIfAborted(signal);
            await this.reviewOpenPRs(cfg, signal);
            throwIfAborted(signal);
            await this.followUpdatedIssues(updated, cfg, signal);
            throwIfAborted(signal);
            const processed = await this.processNext(cfg, signal);
            return { enqueued: updated.enqueued, processed };
        } finally {
            this.running = false;
            await this.deps.store.save(this.key);
        }
    }

    // ─── Queue management (used by commands) ───────────────────────

    async enqueueIssueNumber(issueNumber: number): Promise<TrackedIssue> {
        const existing = this.find(issueNumber);
        if (existing) {
            existing.state = 'pending';
            existing.error = undefined;
            await this.deps.store.save(this.key);
            return existing;
        }
        const issue = await this.forge.getIssue(issueNumber);
        const tracked = this.track(issue);
        this.state.queue.unshift(tracked);
        delete this.state.handled[String(issueNumber)];
        await this.deps.store.save(this.key);
        return tracked;
    }

    async setState(issueNumber: number, state: 'skipped' | 'pending'): Promise<boolean> {
        const tracked = this.find(issueNumber);
        if (!tracked || ACTIVE_STATES.includes(tracked.state)) { return false; }
        tracked.state = state;
        tracked.error = undefined;
        if (state === 'pending') {
            // A reprocess starts from scratch: re-evaluate against the current body.
            tracked.evaluation = undefined;
            tracked.approvedBy = undefined;
        }
        await this.deps.store.save(this.key);
        return true;
    }

    async promote(issueNumber: number): Promise<boolean> {
        const idx = this.state.queue.findIndex((t) => t.issueNumber === issueNumber && t.state === 'pending');
        if (idx < 0) { return false; }
        const [item] = this.state.queue.splice(idx, 1);
        this.state.queue.unshift(item);
        await this.deps.store.save(this.key);
        return true;
    }

    async clearPending(): Promise<number> {
        const before = this.state.queue.length;
        this.state.queue = this.state.queue.filter((t) => t.state !== 'pending');
        await this.deps.store.save(this.key);
        return before - this.state.queue.length;
    }

    // ─── 1. Poll ───────────────────────────────────────────────────

    /** Enqueue new issues; return the set of issue numbers that changed since the last poll. */
    private async pollIssues(cfg: ArgusConfig, signal: AbortSignal): Promise<{ enqueued: number; changed: Set<number> }> {
        const state = this.state;
        const since = state.lastPoll ? new Date(state.lastPoll) : new Date(Date.now() - INITIAL_LOOKBACK_MS);
        // Taken before the request, so issues created while it runs are caught next time.
        const pollStartedAt = new Date().toISOString();

        const issues = await this.forge.listNewIssues(since);
        throwIfAborted(signal);
        let queueFull = false;

        const changed = new Set<number>();
        let enqueued = 0;
        for (const issue of issues) {
            if (issue.state !== 'open') { continue; }
            changed.add(issue.number);
            if (this.find(issue.number) || state.handled[String(issue.number)]) { continue; }

            const pending = state.queue.filter((t) => t.state === 'pending').length;
            if (pending >= cfg.rateLimits.queueDepth) {
                this.log.warn(`${this.key}: queue full (${pending}) — the rest wait for the next poll`);
                queueFull = true;
                break;
            }

            state.queue.push(this.track(issue));
            this.activity(issue.number, undefined, '📥', `Enqueued #${issue.number}: ${oneLine(issue.title, 80)}`, issue.url);
            enqueued++;
        }

        // When the queue filled up, keep the old cursor so the remaining issues are fetched again.
        if (!queueFull) {
            state.lastPoll = pollStartedAt;
        }
        if (enqueued > 0) {
            this.log.info(`${this.key}: enqueued ${enqueued} issue(s)`);
        }
        return { enqueued, changed };
    }

    private track(issue: Issue): TrackedIssue {
        return {
            issueNumber: issue.number,
            repo: this.key,
            title: issue.title,
            url: issue.url,
            state: 'pending',
            createdAt: issue.createdAt,
            bodyHash: hashBody(issue.body),
            // The earliest the current text can have existed. An edit before Argus first saw
            // the issue is not detectable here; later edits move this forward.
            bodySeenAt: issue.createdAt,
            author: issue.author,
            currentIteration: 0,
            maxIterations: readConfig().maxIterations,
        };
    }

    private find(issueNumber: number): TrackedIssue | undefined {
        return this.state.queue.find((t) => t.issueNumber === issueNumber);
    }

    // ─── 2. Open PRs ───────────────────────────────────────────────

    private async reviewOpenPRs(cfg: ArgusConfig, signal: AbortSignal): Promise<void> {
        let openPRs: PullRequest[];
        try {
            openPRs = await this.forge.listOpenPRs();
        } catch (err) {
            this.log.error(`${this.key}: could not list open PRs: ${err}`);
            return;
        }

        try {
            const gated = await this.deps.gatekeeper.assessAll(this.forge, openPRs, signal);
            if (gated > 0) {
                this.activity(undefined, undefined, '🛡️', `Gatekeeper assessed ${gated} PR(s)`);
            }
        } catch (err) {
            if (isAbortError(err)) { throw err; }
            this.log.error(`${this.key}: gatekeeper error: ${err}`);
        }

        // Issues whose PR closed or merged are finished.
        const openNumbers = new Set(openPRs.map((p) => p.number));
        for (const tracked of this.state.queue) {
            if (tracked.state === 'pr-open' && tracked.prNumber && !openNumbers.has(tracked.prNumber)) {
                tracked.state = 'done';
                tracked.completedAt = new Date();
                this.activity(tracked.issueNumber, tracked.prNumber, '✔️', `PR #${tracked.prNumber} closed — #${tracked.issueNumber} done`);
            }
        }

        // Argus only converses on its own PRs; other people's PRs get the merge gate and nothing else.
        for (const pr of openPRs) {
            throwIfAborted(signal);
            if (isWorkInProgress(pr) || !this.isOwnPR(pr)) { continue; }
            if (this.state.disengaged.includes(pr.number)) { continue; }
            try {
                const analysis = await this.loopDetector.analyze(this.forge, pr.number, openPRs);
                if (!analysis.shouldEngage) {
                    await this.postStamped('pr', pr.number, this.loopDetector.generateLoopComment(analysis));
                    this.state.disengaged.push(pr.number);
                    this.activity(undefined, pr.number, '🔄', `Loop detected on PR #${pr.number} — disengaged`);
                    void this.deps.notifier.notify('anomalyDetected', this.key, {
                        title: `Loop detected on PR #${pr.number}`,
                        detail: analysis.reason,
                        url: pr.url,
                    });
                    continue;
                }
                await this.acknowledgeFeedback(pr, cfg);
            } catch (err) {
                if (isAbortError(err)) { throw err; }
                this.log.error(`${this.key}: error checking PR #${pr.number}: ${err}`);
            }
        }
    }

    /**
     * Note new review feedback on one of Argus's PRs. Bounded per PR, never
     * quotes the feedback (it may be hostile), and runs moderation on
     * conversation comments.
     */
    private async acknowledgeFeedback(pr: PullRequest, cfg: ArgusConfig): Promise<void> {
        if (!cfg.comments.processPRComments && !cfg.comments.processPRReviews) { return; }

        const ack = this.state.acks[String(pr.number)];
        if (ack) {
            const elapsed = Date.now() - Date.parse(ack.firstAckAt);
            if (elapsed >= ACK_WINDOW_MS) {
                delete this.state.acks[String(pr.number)];
            } else if (ack.count >= MAX_ACKS_PER_PR) {
                return;
            }
        }

        const [conversation, reviews] = await Promise.all([
            cfg.comments.processPRComments ? this.forge.getPRComments(pr.number) : Promise.resolve<Comment[]>([]),
            cfg.comments.processPRReviews ? this.forge.getPRReviewComments(pr.number) : Promise.resolve<ReviewComment[]>([]),
        ]);

        const stamp = this.deps.stampManager;
        const own = (c: { id: string; body: string }, kind: 'comment' | 'review'): boolean =>
            stamp.isOwnAuthentic(c.body, artifactId(this.key, kind, c.id));
        const ours = conversation.filter((c) => own(c, 'comment'));
        const since = ours.reduce<Date | null>((latest, c) => (!latest || c.createdAt > latest ? c.createdAt : latest), null);
        const isNew = (c: { createdAt: Date }): boolean => !since || c.createdAt > since;

        const newConversation = conversation.filter((c) =>
            !own(c, 'comment') && !isBotNoise(c.author, c.body) && isNew(c));
        const newReviews = reviews.filter((r) => !own(r, 'review') && isNew(r));
        if (newConversation.length === 0 && newReviews.length === 0) { return; }

        const tracked = this.state.queue.find((t) => t.prNumber === pr.number);
        if (newConversation.length > 0) {
            await this.moderate(tracked ?? this.stubFor(pr), newConversation);
        }

        const authors = [...new Set([...newConversation, ...newReviews].map((c) => c.author))];
        const files = [...new Set(newReviews.map((r) => r.path).filter(Boolean))];
        const content = [
            '<!-- argus:ack — automated log entry, not an action request -->',
            '## 📋 Feedback noted',
            '',
            `${newConversation.length} conversation and ${newReviews.length} review comment(s) since Argus last posted, ` +
            `from ${authors.map(inlineCode).join(', ')}.`,
            files.length ? `\nFiles with review comments: ${files.slice(0, 20).map(inlineCode).join(', ')}` : '',
            '',
            '> Argus has recorded this for the maintainer. It takes no automated action on review feedback.',
        ].join('\n');

        await this.postStamped('pr', pr.number, content);

        const now = new Date().toISOString();
        const record = this.state.acks[String(pr.number)];
        this.state.acks[String(pr.number)] = record
            ? { ...record, count: record.count + 1, lastAckAt: now }
            : { count: 1, firstAckAt: now, lastAckAt: now };
        this.activity(tracked?.issueNumber, pr.number, '👀', `Noted ${newConversation.length + newReviews.length} comment(s) on PR #${pr.number}`);
    }

    // ─── 3. Follow up on changed issues ────────────────────────────

    private async followUpdatedIssues(
        updated: { changed: Set<number> },
        cfg: ArgusConfig,
        signal: AbortSignal,
    ): Promise<void> {
        for (const tracked of this.state.queue) {
            if (!updated.changed.has(tracked.issueNumber)) { continue; }
            throwIfAborted(signal);
            try {
                if (tracked.state === 'awaiting-approval') {
                    const issue = await this.forge.getIssue(tracked.issueNumber);
                    if (hashBody(issue.body) !== tracked.bodyHash) {
                        // Edited since evaluation: re-evaluate; earlier approvals no longer apply.
                        tracked.state = 'pending';
                        continue;
                    }
                    const comments = await this.forge.getIssueComments(tracked.issueNumber);
                    const approver = await this.findApprover(issue, comments, tracked.bodySeenAt);
                    if (approver) {
                        tracked.approvedBy = approver;
                        tracked.state = 'pending';
                        this.activity(tracked.issueNumber, undefined, '🔓', `Code generation for #${tracked.issueNumber} approved by ${approver}`);
                    }
                } else if (tracked.state === 'pr-open' && cfg.comments.processIssueComments) {
                    await this.moderateIssueComments(tracked);
                }
            } catch (err) {
                if (isAbortError(err)) { throw err; }
                this.log.error(`${this.key}: follow-up on #${tracked.issueNumber} failed: ${err}`);
            }
        }
    }

    private async moderateIssueComments(tracked: TrackedIssue): Promise<void> {
        const cursor = this.state.commentCursor[String(tracked.issueNumber)];
        const since = cursor ? new Date(cursor) : (tracked.startedAt ?? tracked.createdAt);
        const now = new Date().toISOString();
        const comments = (await this.forge.getCommentsSince(tracked.issueNumber, since))
            .filter((c) => !this.deps.stampManager.isOwnAuthentic(c.body, artifactId(this.key, 'comment', c.id)));
        this.state.commentCursor[String(tracked.issueNumber)] = now;
        if (comments.length > 0) {
            await this.moderate(tracked, comments);
        }
    }

    private async moderate(tracked: TrackedIssue, comments: Comment[]): Promise<void> {
        const actions = await this.deps.commentHandler.processComments(this.forge, tracked, comments);
        for (const action of actions) {
            if (action.needsHumanReview) {
                this.activity(tracked.issueNumber || undefined, tracked.prNumber, '🧑‍⚖️',
                    `Comment by ${action.author} needs human review`, tracked.prUrl ?? tracked.url);
            }
            if (action.threatClassification === 'clean') { continue; }
            this.activity(tracked.issueNumber || undefined, tracked.prNumber, '🛡️',
                `Comment by ${action.author}: ${action.threatClassification}`);
            void this.deps.notifier.notify('threatDetected', this.key, {
                title: `${action.threatClassification} comment by ${action.author}`,
                detail: `Actions: ${(action.actionsTaken ?? []).join(', ') || 'none'}`,
                url: tracked.prUrl ?? tracked.url,
            });
            if ((action.actionsTaken ?? []).includes('blocked')) {
                void this.deps.notifier.notify('userBlocked', this.key, {
                    title: `Blocked ${action.author}`,
                    detail: 'The model confirmed the comment as hostile and auto-block is enabled.',
                });
            }
        }
    }

    private stubFor(pr: PullRequest): TrackedIssue {
        return {
            issueNumber: 0,
            repo: this.key,
            title: pr.title,
            url: pr.url,
            state: 'pr-open',
            createdAt: pr.createdAt,
            bodyHash: '',
            currentIteration: 0,
            maxIterations: 0,
            prNumber: pr.number,
            prUrl: pr.url,
        };
    }

    // ─── 4. Process one issue ──────────────────────────────────────

    private async processNext(cfg: ArgusConfig, signal: AbortSignal): Promise<TrackedIssue | undefined> {
        const next = this.state.queue.find((t) => t.state === 'pending');
        if (!next) { return undefined; }

        const hourAgo = Date.now() - 60 * 60 * 1000;
        const startedThisHour = this.state.issueStarts.filter((t) => Date.parse(t) > hourAgo).length;
        if (startedThisHour >= cfg.rateLimits.issuesPerHour) {
            this.log.debug(`${this.key}: issue budget spent (${startedThisHour}/${cfg.rateLimits.issuesPerHour} this hour)`);
            return undefined;
        }
        if (!this.deps.slots.tryAcquire()) {
            this.log.debug(`${this.key}: concurrency limit reached`);
            return undefined;
        }

        this.state.issueStarts.push(new Date().toISOString());
        const watchdog = linkedController([signal], cfg.watchdogTimeoutMinutes * 60_000, 'watchdog timeout');
        try {
            await this.processIssue(next, cfg, watchdog.controller.signal);
        } finally {
            watchdog.dispose();
            this.deps.slots.release();
            await this.deps.store.save(this.key);
        }
        return next;
    }

    private async processIssue(tracked: TrackedIssue, cfg: ArgusConfig, signal: AbortSignal): Promise<void> {
        tracked.state = 'evaluating';
        tracked.startedAt = new Date();
        tracked.maxIterations = cfg.maxIterations;
        tracked.error = undefined;

        try {
            const issue = await this.forge.getIssue(tracked.issueNumber);
            if (issue.state !== 'open') {
                return this.finish(tracked, 'skipped', '⏭️', `#${tracked.issueNumber} is closed — skipped`);
            }

            // Idempotency: an Argus PR for this issue already exists (e.g. after a crash or reinstall).
            const existing = await this.findOwnPR(tracked.issueNumber);
            if (existing) {
                tracked.prNumber = existing.number;
                tracked.prUrl = existing.url;
                tracked.state = 'pr-open';
                this.activity(tracked.issueNumber, existing.number, '🔗', `#${tracked.issueNumber} already has Argus PR #${existing.number}`);
                return;
            }

            // Multi-instance sovereignty: if another Argus instance (posting from an
            // account with write access) already claimed this issue, leave it alone.
            const issueComments = await this.forge.getIssueComments(tracked.issueNumber);
            const ownership = await resolveOwnership(this.forge, this.deps.stampManager, this.deps.trust,
                issueComments.map((c) => ({
                    body: c.body, author: c.author, authorAssociation: c.authorAssociation,
                    id: artifactId(this.key, 'comment', c.id),
                })));
            if (ownership.owner === 'other') {
                return this.finish(tracked, 'skipped', '🤝',
                    `#${tracked.issueNumber} is being handled by another Argus instance (${ownership.author})`);
            }

            // ── Evaluate (reused if the body hasn't changed since an earlier evaluation) ──
            const bodyHash = hashBody(issue.body);
            let evaluation = tracked.evaluation;
            if (!evaluation || tracked.bodyHash !== bodyHash) {
                if (tracked.bodyHash !== bodyHash) {
                    tracked.bodySeenAt = new Date();
                }
                tracked.bodyHash = bodyHash;
                tracked.approvedBy = undefined;
                this.activity(tracked.issueNumber, undefined, '🔍', `Evaluating #${tracked.issueNumber}`);
                evaluation = await this.deps.evaluator.evaluate(this.forge, issue, signal);
                tracked.evaluation = evaluation;
                await this.auditEvaluation(tracked, evaluation);
                await this.applyTriageLabels(tracked, evaluation, cfg);
            }

            if (evaluation.reviewRequired) {
                return this.finish(tracked, 'flagged', '🧑‍⚖️', `#${tracked.issueNumber} needs human review: ${oneLine(evaluation.reasoning, 100)}`);
            }
            if (!evaluation.merit) {
                return evaluation.confidence < REJECT_CONFIDENCE
                    ? this.finish(tracked, 'flagged', '🧑‍⚖️', `#${tracked.issueNumber}: low-confidence rejection — needs human review`)
                    : this.finish(tracked, 'rejected', '❌', `Rejected #${tracked.issueNumber}: ${oneLine(evaluation.reasoning, 100)}`);
            }
            if (['question', 'duplicate', 'invalid'].includes(evaluation.category)) {
                return this.finish(tracked, 'done', '🏷️', `#${tracked.issueNumber} triaged as ${evaluation.category} — no code needed`);
            }

            // ── Trust gate ──
            if (!tracked.approvedBy) {
                tracked.approvedBy = await this.findApprover(issue, issueComments, tracked.bodySeenAt);
            }
            if (!tracked.approvedBy) {
                tracked.state = 'awaiting-approval';
                this.activity(tracked.issueNumber, undefined, '🔒',
                    `#${tracked.issueNumber} triaged; waiting for a trusted user to comment "/argus fix"`);
                return;
            }

            await this.buildFix(tracked, issue, evaluation, cfg, signal);
        } catch (err) {
            this.handleFailure(tracked, err);
        }
    }

    /**
     * Who, if anyone, has authorized code generation: the author if trusted,
     * otherwise the first trusted commenter who wrote `/argus fix`.
     * Association comes from the forge, so it can't be spoofed in comment text.
     */
    private async findApprover(issue: Issue, comments: Comment[], bodySeenAt?: Date): Promise<string | undefined> {
        const trust = this.deps.trust;
        if (await trust.isTrustedForCodeGen(this.forge, issue.author, issue.authorAssociation)) {
            return issue.author;
        }
        for (const c of comments) {
            if (!APPROVAL_COMMAND.test(c.body)) { continue; }
            // An approval only covers the text that existed when it was given.
            if (bodySeenAt && c.createdAt <= bodySeenAt) { continue; }
            if (await trust.isTrustedForCodeGen(this.forge, c.author, c.authorAssociation)) {
                return c.author;
            }
        }
        return undefined;
    }

    private async buildFix(
        tracked: TrackedIssue,
        issue: Issue,
        evaluation: IssueEvaluation,
        cfg: ArgusConfig,
        signal: AbortSignal,
    ): Promise<void> {
        const forge = this.forge;
        tracked.state = 'approved';
        this.activity(tracked.issueNumber, undefined, '✅',
            `Working on #${tracked.issueNumber} (${evaluation.category}/${evaluation.severity}, approved by ${tracked.approvedBy})`);

        // Don't spend model calls and pushes on a fix that can't be published this hour.
        const budget = this.deps.writeBudget;
        if (budget('pr') < 1 || budget('push') < 1 || budget('branch') < 1 || budget('comment') < 2) {
            tracked.state = 'pending';
            this.log.info(`${this.key}: #${tracked.issueNumber} deferred — write budget (argus.rateLimits.*) exhausted for now`);
            return;
        }

        // ── Branch (reused if a previous attempt created it) ──
        tracked.state = 'branching';
        const defaultBranch = await forge.getDefaultBranch();
        const branch = `${cfg.branchPrefix}issue-${tracked.issueNumber}`;
        tracked.branchName = branch;
        if (!(await forge.branchExists(branch))) {
            await forge.createBranch(defaultBranch, branch);
            this.activity(tracked.issueNumber, undefined, '🌿', `Created branch ${branch}`);
        }

        // ── Investigate & code ──
        // In dry run the branch was never created, so read from the default branch.
        throwIfAborted(signal);
        const readBranch = (await forge.branchExists(branch)) ? branch : defaultBranch;
        const investigation = await this.deps.investigator.investigate(forge, evaluation, readBranch, signal);

        tracked.state = 'coding';
        if (!(await this.editCheck(tracked, cfg))) { return; }

        const title = this.deps.sanitizer.sanitize(issue.title).sanitized;
        const body = this.deps.sanitizer.sanitize(issue.body).sanitized;
        this.activity(tracked.issueNumber, undefined, '🔧', `Coding #${tracked.issueNumber}`);
        const iterations = await this.deps.coder.code(forge, tracked, evaluation, investigation, {
            maxIterations: cfg.maxIterations,
            maxDiffLines: cfg.maxDiffLines,
            signal,
            issueTitle: title,
            issueBody: body,
        });

        const committed = iterations.filter((it) => it.commitSha);
        if (committed.length === 0) {
            const reason = iterations[iterations.length - 1]?.selfReview ?? 'no changes produced';
            this.finish(tracked, 'stuck', '🧱', `#${tracked.issueNumber}: no commit — ${oneLine(reason, 100)}`);
            tracked.error = reason;
            void this.deps.notifier.notify('prStuck', this.key, {
                title: `Argus could not produce a fix for #${tracked.issueNumber}`,
                detail: reason,
                url: tracked.url,
            });
            return;
        }

        // The issue must still say what we evaluated before we publish a PR for it.
        if (!(await this.editCheck(tracked, cfg))) { return; }

        // ── PR ──
        throwIfAborted(signal);
        tracked.state = 'pr-open';
        const last = iterations[iterations.length - 1];
        const prTitle = `${evaluation.category}: ${oneLine(issue.title, 100)} (#${tracked.issueNumber})`;
        const prBody = this.buildPRBody(tracked, evaluation, iterations);
        const pr = await forge.createPullRequest(branch, defaultBranch, prTitle, prBody.stamped);
        if (pr.number <= 0) {
            // Dry run: nothing was written. Don't record a PR, so turning dry run off and
            // reprocessing does the real thing.
            this.finish(tracked, 'skipped', '🧪', `[DRY RUN] #${tracked.issueNumber}: would open a PR (${iterations.length} iteration(s))`);
            tracked.error = 'Dry run — nothing was written. Reprocess to run it for real.';
            return;
        }
        this.deps.stampManager.recordPosted(prBody.stamp, artifactId(this.key, 'pr', pr.number), this.key);
        tracked.prNumber = pr.number;
        tracked.prUrl = pr.url;
        this.state.commentCursor[String(tracked.issueNumber)] = new Date().toISOString();

        await this.deps.transcriber.postTranscript(forge, pr.number, tracked, evaluation, investigation, iterations);
        await this.postIssueAcknowledgment(tracked, pr, evaluation);
        await this.deps.auditLog.append({
            action: 'create_pr',
            repo: `${forge.owner}/${forge.repo}`,
            target: pr.url,
            input: tracked.bodyHash,
            output: String(pr.number),
            decision: `PR #${pr.number} created`,
            llmCallCount: iterations.length,
            details: `${iterations.length} iteration(s), CI ${last?.ciResult ?? 'unknown'}, approved by ${tracked.approvedBy}`,
        });
        this.activity(tracked.issueNumber, pr.number, '📤', `Opened PR #${pr.number}`, pr.url);
        void this.deps.notifier.notify('prOpened', this.key, {
            title: `PR #${pr.number} opened for #${tracked.issueNumber}`,
            detail: `${oneLine(issue.title, 120)} — CI ${last?.ciResult ?? 'unknown'}`,
            url: pr.url,
        });
        if (last?.ciResult === 'passing') {
            void this.deps.notifier.notify('ciPassedFinal', this.key, {
                title: `CI passing on PR #${pr.number}`,
                detail: `Ready for human review.`,
                url: pr.url,
            });
        }

        // ── Competing PRs ──
        if (cfg.prAnalysis.enabled) {
            try {
                tracked.state = 'analyzing-competing';
                const competing = await this.deps.prAnalyzer.analyzeCompetingPRs(forge, tracked);
                tracked.competingPRs = competing;
                const others = competing.filter((c) => !c.isOurInstance);
                if (others.length > 0) {
                    await this.deps.transcriber.postCompetitiveAnalysis(forge, pr.number, competing);
                    this.activity(tracked.issueNumber, pr.number, '⚔️', `Analyzed ${others.length} competing PR(s)`);
                    const ours = competing.find((c) => c.isOurInstance);
                    if (cfg.prAnalysis.synthesisEnabled && this.deps.prAnalyzer.shouldSynthesize(ours, others)) {
                        tracked.state = 'synthesizing';
                        const plan = await this.deps.prAnalyzer.planSynthesis(others, ours);
                        await this.deps.transcriber.postSynthesisPlan(forge, pr.number, plan);
                    }
                }
            } catch (err) {
                if (isAbortError(err)) { throw err; }
                this.log.warn(`${this.key}: competing-PR analysis failed for #${tracked.issueNumber}: ${err}`);
            } finally {
                tracked.state = 'pr-open';
            }
        }
    }

    /** Returns false (and flags the issue) if the body changed since evaluation. */
    private async editCheck(tracked: TrackedIssue, cfg: ArgusConfig): Promise<boolean> {
        if (!vscode.workspace.getConfiguration('argus').get<boolean>('security.reEvaluateOnEdit', true)) { return true; }
        const result = await this.deps.editDetector.check(this.forge, tracked);
        if (!result.detected) { return true; }

        this.finish(tracked, 'flagged', '🚨', `Halted #${tracked.issueNumber}: ${result.reason}`);
        tracked.error = result.reason;
        // Re-evaluate from scratch if someone reprocesses it.
        tracked.evaluation = undefined;
        tracked.approvedBy = undefined;
        await this.safeLabel(tracked.issueNumber, cfg.labels.subversionDetected);
        void this.deps.notifier.notify('anomalyDetected', this.key, {
            title: `Issue #${tracked.issueNumber} changed while Argus was working`,
            detail: result.reason,
            url: tracked.url,
        });
        return false;
    }

    private async findOwnPR(issueNumber: number): Promise<PullRequest | undefined> {
        try {
            const prs = await this.forge.listPRsForIssue(issueNumber);
            return prs.find((p) => p.state === 'open' && this.isOwnPR(p));
        } catch (err) {
            this.log.debug(`${this.key}: could not list PRs for #${issueNumber}: ${err}`);
            return undefined;
        }
    }

    private async applyTriageLabels(tracked: TrackedIssue, evaluation: IssueEvaluation, cfg: ArgusConfig): Promise<void> {
        const labels: string[] = [];
        if (evaluation.reviewRequired || (!evaluation.merit && evaluation.confidence < REJECT_CONFIDENCE)) {
            labels.push(cfg.labels.needsReview);
        } else {
            labels.push(evaluation.merit ? cfg.labels.approved : cfg.labels.rejected);
        }

        // Suggested labels come from the model, so only apply ones the repo already has.
        if (evaluation.suggestedLabels.length > 0) {
            try {
                const existing = new Map((await this.forge.listRepoLabels()).map((l) => [l.toLowerCase(), l]));
                for (const s of evaluation.suggestedLabels) {
                    const match = existing.get(s.toLowerCase());
                    if (match) { labels.push(match); }
                }
            } catch (err) {
                this.log.debug(`${this.key}: could not list labels: ${err}`);
            }
        }

        for (const label of [...new Set(labels)].slice(0, 6)) {
            await this.safeLabel(tracked.issueNumber, label);
        }
    }

    private async safeLabel(issueNumber: number, label: string): Promise<void> {
        try {
            await this.forge.addLabel(issueNumber, label);
        } catch (err) {
            if (isAbortError(err)) { throw err; }
            this.log.warn(`${this.key}: could not label #${issueNumber} "${label}": ${err}`);
        }
    }

    private buildPRBody(tracked: TrackedIssue, evaluation: IssueEvaluation, iterations: CodingIteration[]): ReturnType<StampManager['stampContent']> {
        const last = iterations[iterations.length - 1];
        const files = [...new Set(iterations.flatMap((it) => it.filesChanged.map((f) => f.path)))];
        const ci = last?.ciResult === 'passing' ? '✅ passing'
            : last?.ciResult === 'none' ? '➖ no CI configured — test manually'
                : '⚠️ not passing — human review required';

        const content = `## Automated fix for #${tracked.issueNumber}

Closes #${tracked.issueNumber}

### Approach
${neutralizeModelText(evaluation.proposedApproach, 4000)}

### Files changed
${files.map((f) => `- ${inlineCode(f)}`).join('\n') || '_none_'}

### CI
${ci}

---

> 🤖 Generated by **Argus** at the request of ${inlineCode(tracked.approvedBy ?? 'unknown')}.
> A human must review this before merging. Argus never merges.
> The full reasoning transcript is in the comments below.`;

        return this.deps.stampManager.stampContent(content);
    }

    private isOwnPR(pr: PullRequest): boolean {
        return this.deps.stampManager.isOwnAuthentic(pr.body, artifactId(this.key, 'pr', pr.number));
    }

    private async postIssueAcknowledgment(tracked: TrackedIssue, pr: PullRequest, evaluation: IssueEvaluation): Promise<void> {
        try {
            const comments = await this.forge.getIssueComments(tracked.issueNumber);
            const decision = new EngagementPolicy(this.deps.stampManager, this.log).decide(comments);
            if (!decision.engage) {
                this.log.info(`${this.key}: not acknowledging #${tracked.issueNumber} — ${decision.reason}`);
                return;
            }
        } catch (err) {
            this.log.debug(`${this.key}: could not read comments on #${tracked.issueNumber}: ${err}`);
            return;
        }

        const content = `## 🤖 Argus opened a pull request

#${pr.number} proposes a fix (${evaluation.category}, ${evaluation.severity} severity).

A maintainer will review it. Argus never merges.`;
        await this.postStamped('issue', tracked.issueNumber, content);
    }

    /**
     * Stamp, post, and bind the stamp to the new comment, so a verbatim copy
     * elsewhere is recognized as a replay rather than as Argus's own.
     */
    private async postStamped(target: 'issue' | 'pr', number: number, content: string): Promise<void> {
        const { stamped, stamp } = this.deps.stampManager.stampContent(content);
        const comment = target === 'pr'
            ? await this.forge.addPRComment(number, stamped)
            : await this.forge.addComment(number, stamped);
        if (comment?.id && !comment.id.startsWith('dry-run-')) {
            this.deps.stampManager.recordPosted(stamp, artifactId(this.key, 'comment', comment.id), this.key);
        }
    }

    private async auditEvaluation(tracked: TrackedIssue, evaluation: IssueEvaluation): Promise<void> {
        await this.deps.auditLog.append({
            action: 'evaluate_issue',
            repo: `${this.forge.owner}/${this.forge.repo}`,
            target: tracked.url,
            input: tracked.bodyHash,
            output: JSON.stringify({ merit: evaluation.merit, confidence: evaluation.confidence, category: evaluation.category }),
            decision: evaluation.reviewRequired ? 'review-required' : evaluation.merit ? 'merit' : 'no-merit',
            llmCallCount: 1,
            details: oneLine(evaluation.reasoning, 200),
        });
    }

    // ─── Helpers ───────────────────────────────────────────────────

    private finish(tracked: TrackedIssue, state: TrackedIssue['state'], icon: string, message: string): void {
        tracked.state = state;
        tracked.completedAt = new Date();
        this.activity(tracked.issueNumber, tracked.prNumber, icon, message, tracked.prUrl ?? tracked.url);
    }

    private handleFailure(tracked: TrackedIssue, err: unknown): void {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof Error && err.name === 'LlmRefusalError') {
            this.finish(tracked, 'flagged', '🧑‍⚖️', `#${tracked.issueNumber}: the model declined — needs human review`);
            tracked.error = message;
            return;
        }
        if (err instanceof Error && err.name === 'LlmUnavailableError') {
            // Not configured / signed out: nothing was attempted, try again later.
            tracked.state = 'pending';
            tracked.error = message;
            this.log.warn(`${this.key}: #${tracked.issueNumber} deferred — ${message}`);
            return;
        }
        if (err instanceof Error && ['ForgeRateLimitError', 'LlmRateLimitError', 'LlmUsageLimitError'].includes(err.name)) {
            // Budget exhausted: try again on a later cycle.
            tracked.state = 'pending';
            tracked.error = message;
            this.log.warn(`${this.key}: #${tracked.issueNumber} deferred — ${message}`);
            void this.deps.notifier.notify('rateLimitWarning', this.key, { title: 'Argus hit a rate limit', detail: message });
            return;
        }
        if (isAbortError(err)) {
            this.finish(tracked, 'stuck', '⏹️', `#${tracked.issueNumber} stopped: ${message}`);
            tracked.error = message;
            return;
        }
        this.finish(tracked, 'stuck', '💥', `#${tracked.issueNumber} failed: ${oneLine(message, 100)}`);
        tracked.error = message;
        this.log.error(`${this.key}: pipeline failed for #${tracked.issueNumber}: ${message}`);
        void this.deps.notifier.notify('systemError', this.key, {
            title: `Pipeline error on #${tracked.issueNumber}`,
            detail: message,
            url: tracked.url,
        });
    }

    private activity(issueNumber: number | undefined, prNumber: number | undefined, icon: string, message: string, url?: string): void {
        this.deps.store.addActivity({ repo: this.key, issueNumber, prNumber, icon, message, url });
    }
}

function hashBody(body: string): string {
    return createHash('sha256').update(body || '').digest('hex');
}
