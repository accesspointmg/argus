// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * GuardedForge — the single choke point for forge writes.
 *
 * Every write goes: halt check → dry-run no-op → redact outbound text →
 * rate limit → delegate. Reads pass straight through. Wrap every forge the
 * pipeline uses; nothing else should hold the inner forge.
 */

import type { Logger } from '../util/logger';
import type {
    Forge,
    ForgePlatform,
    Issue,
    Comment,
    ReviewComment,
    PullRequest,
    FileChange,
    CheckRun,
    CommitStatus,
    CodeSearchResult,
    CommitFile,
    RepoRole,
    UserHistory,
    TreeEntry,
    TokenValidation,
} from './types';
import { HaltedError, ForgeRateLimitError, type WriteKind } from './errors';

export { HaltedError, ForgeRateLimitError };
export type { WriteKind };

/** Budget for forge writes. `take` throws (ForgeRateLimitError) when exhausted. */
export interface WriteLimiter {
    take(kind: WriteKind): void;
}

export interface GuardedForgeOptions {
    isDryRun(): boolean;
    isHalted(): boolean;
    /** Scrubs secrets from outbound text. Applied to every string Argus publishes. */
    redact(text: string): string;
    limiter?: WriteLimiter;
    logger: Pick<Logger, 'info' | 'warn'>;
    audit?: (action: string, details: Record<string, unknown>) => void;
}

export class GuardedForge implements Forge {
    private dryRunCounter = 0;

    constructor(private readonly inner: Forge, private readonly opts: GuardedForgeOptions) {}

    get platform(): ForgePlatform { return this.inner.platform; }
    get owner(): string { return this.inner.owner; }
    get repo(): string { return this.inner.repo; }

    private get where(): string {
        return `${this.inner.platform}:${this.inner.owner}/${this.inner.repo}`;
    }

    /**
     * Run one write through the guard. `describe` is a short human summary for logs;
     * `details` goes to the audit sink (no bodies — lengths only).
     */
    private async write<T>(
        action: string,
        kind: WriteKind,
        describe: string,
        details: Record<string, unknown>,
        dryRunResult: () => T,
        /** Redacts outbound text, then returns the call to make. */
        prepare: () => () => Promise<T>,
    ): Promise<T> {
        const audit = (outcome: string, extra?: Record<string, unknown>): void => {
            try {
                this.opts.audit?.(action, { repo: this.where, kind, outcome, ...details, ...extra });
            } catch { /* audit sink failures must not change write behavior */ }
        };

        if (this.opts.isHalted()) {
            audit('halted');
            throw new HaltedError(describe);
        }
        if (this.opts.isDryRun()) {
            this.opts.logger.info(`[DRY RUN] would ${describe} on ${this.where}`);
            audit('dry-run');
            return dryRunResult();
        }
        const perform = prepare();
        try {
            this.opts.limiter?.take(kind);
        } catch (err) {
            this.opts.logger.warn(`Refused to ${describe} on ${this.where}: ${err instanceof Error ? err.message : err}`);
            audit('rate-limited');
            throw err;
        }
        try {
            const result = await perform();
            audit('done');
            return result;
        } catch (err) {
            audit('failed', { error: err instanceof Error ? err.message : String(err) });
            throw err;
        }
    }

    private redact(text: string): string {
        return this.opts.redact(text);
    }

    private nextDryRunId(): string {
        return `dry-run-${++this.dryRunCounter}`;
    }

    private stubComment(issueNumber: number, body: string): Comment {
        const now = new Date();
        return {
            id: this.nextDryRunId(),
            body,
            author: 'argus-dry-run',
            authorAssociation: 'NONE',
            url: '',
            createdAt: now,
            updatedAt: now,
            issueNumber,
        };
    }

    // ─── Reads (pass-through) ───────────────────────────────────────

    listNewIssues(since: Date): Promise<Issue[]> { return this.inner.listNewIssues(since); }
    getIssue(issueNumber: number): Promise<Issue> { return this.inner.getIssue(issueNumber); }
    getIssueComments(issueNumber: number): Promise<Comment[]> { return this.inner.getIssueComments(issueNumber); }
    getCommentsSince(issueNumber: number, since: Date): Promise<Comment[]> { return this.inner.getCommentsSince(issueNumber, since); }
    listRepoLabels(): Promise<string[]> { return this.inner.listRepoLabels(); }
    listOpenPRs(): Promise<PullRequest[]> { return this.inner.listOpenPRs(); }
    listPRsForIssue(issueNumber: number): Promise<PullRequest[]> { return this.inner.listPRsForIssue(issueNumber); }
    getPullRequest(prNumber: number): Promise<PullRequest> { return this.inner.getPullRequest(prNumber); }
    getPRComments(prNumber: number): Promise<Comment[]> { return this.inner.getPRComments(prNumber); }
    getPRReviewComments(prNumber: number): Promise<ReviewComment[]> { return this.inner.getPRReviewComments(prNumber); }
    getPRFiles(prNumber: number): Promise<FileChange[]> { return this.inner.getPRFiles(prNumber); }
    getDefaultBranch(): Promise<string> { return this.inner.getDefaultBranch(); }
    branchExists(branch: string): Promise<boolean> { return this.inner.branchExists(branch); }
    getFileContent(branch: string, path: string): Promise<string> { return this.inner.getFileContent(branch, path); }
    listTree(branch: string, path?: string, recursive?: boolean): Promise<TreeEntry[]> { return this.inner.listTree(branch, path, recursive); }
    getCommitStatuses(ref: string): Promise<CommitStatus[]> { return this.inner.getCommitStatuses(ref); }
    getCheckRuns(ref: string): Promise<CheckRun[]> { return this.inner.getCheckRuns(ref); }
    getCheckRunLog(checkRunId: string): Promise<string> { return this.inner.getCheckRunLog(checkRunId); }
    searchCode(query: string): Promise<CodeSearchResult[]> { return this.inner.searchCode(query); }
    getUserRole(username: string): Promise<RepoRole> { return this.inner.getUserRole(username); }
    getUserHistory(username: string): Promise<UserHistory> { return this.inner.getUserHistory(username); }
    validateTokenScopes(): Promise<TokenValidation> { return this.inner.validateTokenScopes(); }

    // ─── Writes ─────────────────────────────────────────────────────

    addLabel(issueNumber: number, label: string): Promise<void> {
        return this.write('addLabel', 'label', `add label "${label}" to #${issueNumber}`,
            { issueNumber, label }, () => undefined,
            () => () => this.inner.addLabel(issueNumber, label));
    }

    removeLabel(issueNumber: number, label: string): Promise<void> {
        return this.write('removeLabel', 'label', `remove label "${label}" from #${issueNumber}`,
            { issueNumber, label }, () => undefined,
            () => () => this.inner.removeLabel(issueNumber, label));
    }

    addComment(issueNumber: number, body: string): Promise<Comment> {
        return this.write('addComment', 'comment', `comment on #${issueNumber} (${body.length} chars)`,
            { issueNumber, length: body.length }, () => this.stubComment(issueNumber, body),
            () => { const b = this.redact(body); return () => this.inner.addComment(issueNumber, b); });
    }

    updateIssue(issueNumber: number, updates: { title?: string; body?: string }): Promise<void> {
        return this.write('updateIssue', 'comment', `update issue #${issueNumber}`,
            { issueNumber, title: updates.title !== undefined, body: updates.body !== undefined }, () => undefined,
            () => {
                const u = {
                    ...(updates.title !== undefined && { title: this.redact(updates.title) }),
                    ...(updates.body !== undefined && { body: this.redact(updates.body) }),
                };
                return () => this.inner.updateIssue(issueNumber, u);
            });
    }

    createPullRequest(head: string, base: string, title: string, body: string): Promise<PullRequest> {
        return this.write('createPullRequest', 'pr', `open PR ${head} → ${base}`,
            { head, base }, () => this.stubPR(head, base, title, body),
            () => {
                const t = this.redact(title);
                const b = this.redact(body);
                return () => this.inner.createPullRequest(head, base, t, b);
            });
    }

    addPRComment(prNumber: number, body: string): Promise<Comment> {
        return this.write('addPRComment', 'comment', `comment on PR #${prNumber} (${body.length} chars)`,
            { prNumber, length: body.length }, () => this.stubComment(prNumber, body),
            () => { const b = this.redact(body); return () => this.inner.addPRComment(prNumber, b); });
    }

    updatePRBody(prNumber: number, body: string): Promise<void> {
        return this.write('updatePRBody', 'comment', `update PR #${prNumber} body`,
            { prNumber, length: body.length }, () => undefined,
            () => { const b = this.redact(body); return () => this.inner.updatePRBody(prNumber, b); });
    }

    createBranch(baseBranch: string, newBranch: string): Promise<void> {
        return this.write('createBranch', 'branch', `create branch ${newBranch} from ${baseBranch}`,
            { baseBranch, newBranch }, () => undefined,
            () => () => this.inner.createBranch(baseBranch, newBranch));
    }

    createOrUpdateFile(branch: string, path: string, content: string, message: string): Promise<void> {
        return this.write('createOrUpdateFile', 'push', `write ${path} on ${branch}`,
            { branch, files: [path] }, () => undefined,
            () => {
                const c = this.redactFile(path, content);
                const m = this.redact(message);
                return () => this.inner.createOrUpdateFile(branch, path, c, m);
            });
    }

    commitFiles(branch: string, files: CommitFile[], message: string): Promise<string> {
        const paths = files.map((f) => f.path);
        return this.write('commitFiles', 'push', `commit ${files.length} file(s) to ${branch}`,
            { branch, files: paths, deletes: files.filter((f) => f.content === null).length },
            () => this.nextDryRunId(),
            () => {
                const out = files.map((f) => ({ path: f.path, content: f.content === null ? null : this.redactFile(f.path, f.content) }));
                const m = this.redact(message);
                return () => this.inner.commitFiles(branch, out, m);
            });
    }

    createCommitStatus(
        ref: string,
        state: CommitStatus['state'],
        context: string,
        description: string,
        targetUrl?: string,
    ): Promise<void> {
        return this.write('createCommitStatus', 'status', `set status ${context}=${state} on ${ref.slice(0, 12)}`,
            { ref, state, context }, () => undefined,
            () => { const d = this.redact(description); return () => this.inner.createCommitStatus(ref, state, context, d, targetUrl); });
    }

    deleteComment(commentId: string): Promise<void> {
        return this.write('deleteComment', 'delete', `delete comment ${commentId}`,
            { commentId }, () => undefined,
            () => () => this.inner.deleteComment(commentId));
    }

    blockUser(username: string): Promise<void> {
        return this.write('blockUser', 'block', `block @${username}`,
            { username }, () => undefined,
            () => () => this.inner.blockUser(username));
    }

    unblockUser(username: string): Promise<void> {
        return this.write('unblockUser', 'block', `unblock @${username}`,
            { username }, () => undefined,
            () => () => this.inner.unblockUser(username));
    }

    reportUser(username: string, reason: string): Promise<void> {
        return this.write('reportUser', 'block', `report @${username}`,
            { username }, () => undefined,
            () => { const r = this.redact(reason); return () => this.inner.reportUser(username, r); });
    }

    /** File contents are redacted too — a leaked secret in a commit is still a leak. */
    private redactFile(path: string, content: string): string {
        const out = this.redact(content);
        if (out !== content) {
            this.opts.logger.warn(`Redacted secret-like content from ${path} before pushing to ${this.where}`);
        }
        return out;
    }

    private stubPR(head: string, base: string, title: string, body: string): PullRequest {
        const now = new Date();
        return {
            id: this.nextDryRunId(),
            number: 0,
            title,
            body,
            author: 'argus-dry-run',
            authorAssociation: 'NONE',
            state: 'open',
            draft: false,
            head,
            headSha: '',
            base,
            url: '',
            apiUrl: '',
            labels: [],
            createdAt: now,
            updatedAt: now,
            repo: `${this.inner.platform}:${this.inner.owner}/${this.inner.repo}`,
        };
    }
}

/** One budget: at most `limit` writes in any trailing `windowMs`. */
export interface WriteLimit {
    limit: number;
    windowMs: number;
    /** Setting name shown in the refusal message, e.g. `argus.rateLimits.commentsPerHour`. */
    setting?: string;
}

/**
 * Sliding-window limiter, one window per kind. Kinds without an entry are
 * unlimited. A limit of 0 (or anything non-finite/negative) allows nothing —
 * "0" never means "unlimited". Share one instance across repos for global caps.
 */
export class HourlyWriteLimiter implements WriteLimiter {
    private limits: Partial<Record<WriteKind, WriteLimit>>;
    private readonly history = new Map<WriteKind, number[]>();

    constructor(limits: Partial<Record<WriteKind, WriteLimit>>, private readonly now: () => number = Date.now) {
        this.limits = { ...limits };
    }

    /** Replace limits; history is kept, so reconfiguring never refills a budget. */
    configure(limits: Partial<Record<WriteKind, WriteLimit>>): void {
        this.limits = { ...limits };
    }

    take(kind: WriteKind): void {
        const cfg = this.limits[kind];
        if (!cfg) { return; }
        const max = sanitizeLimit(cfg.limit);
        const windowMs = cfg.windowMs > 0 && Number.isFinite(cfg.windowMs) ? cfg.windowMs : 3_600_000;
        const now = this.now();
        const events = this.prune(kind, now, windowMs);
        if (events.length >= max) {
            const retryAfterMs = events.length > 0 ? Math.max(0, events[0] + windowMs - now) : windowMs;
            throw new ForgeRateLimitError(kind, max, windowMs, retryAfterMs, cfg.setting);
        }
        events.push(now);
    }

    /** Writes left in the current window (Infinity for unlimited kinds). */
    remaining(kind: WriteKind): number {
        const cfg = this.limits[kind];
        if (!cfg) { return Infinity; }
        const windowMs = cfg.windowMs > 0 && Number.isFinite(cfg.windowMs) ? cfg.windowMs : 3_600_000;
        return Math.max(0, sanitizeLimit(cfg.limit) - this.prune(kind, this.now(), windowMs).length);
    }

    private prune(kind: WriteKind, now: number, windowMs: number): number[] {
        const events = (this.history.get(kind) ?? []).filter((t) => t > now - windowMs);
        this.history.set(kind, events);
        return events;
    }
}

function sanitizeLimit(limit: number): number {
    return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
}
