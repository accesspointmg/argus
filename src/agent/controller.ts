// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * ArgusController — owns the per-repo pipelines and their schedule.
 *
 *  - Each repo runs on its own timer. The next cycle is scheduled only after
 *    the previous one finishes, so cycles never overlap.
 *  - Every forge is wrapped in a GuardedForge: dry run, halt, outbound
 *    redaction and the write rate limits are enforced there, below all agent
 *    code, so no code path can skip them.
 *  - Stop aborts in-flight work. Emergency Stop also sets a halt that blocks
 *    every forge write until Argus is started again.
 *  - Settings are re-read on change; repos are added or removed live.
 */

import * as vscode from 'vscode';
import type * as vsc from 'vscode';
import type { Forge, RepoConfig, RepoKey } from '../forge/types';
import { repoKey } from '../forge/types';
import { createForge } from '../forge/factory';
import { GuardedForge, HourlyWriteLimiter } from '../forge/guarded';
import type { LlmService } from '../llm';
import type { AuditLog } from '../crypto/audit';
import type { NotificationRouter } from '../notifications/events';
import type { Logger } from '../util/logger';
import type { ArgusConfig } from '../util/config';
import { readConfig, formatRepoString } from '../util/config';
import { isAbortError } from '../util/abort';
import { RepoPipeline, type PipelineDeps, type WorkSlots } from './pipeline';
import type { StateStore } from './state-store';
import type { ActivityEntry, TrackedIssue } from './types';

export type ControllerDeps = Omit<PipelineDeps, 'store' | 'slots' | 'writeBudget'> & {
    store: StateStore;
    secrets: vsc.SecretStorage;
    llm: LlmService;
    auditLog: AuditLog;
    notifier: NotificationRouter;
    logger: Logger;
};

export type ControllerStatus = 'stopped' | 'idle' | 'polling' | 'halted';

const HOUR = 60 * 60 * 1000;

export class ArgusController implements vscode.Disposable {
    private pipelines = new Map<RepoKey, RepoPipeline>();
    private forges = new Map<RepoKey, Forge>();
    private timers = new Map<RepoKey, NodeJS.Timeout>();
    private abort = new AbortController();
    /** Signal for a manual Poll Now while stopped; Stop aborts it too. */
    private manualAbort = new AbortController();
    /** Cycles in flight, so shutdown can wait for their final state save. */
    private inflight = new Set<Promise<void>>();
    /** Repos that got new work while a cycle was running; they re-run right after it. */
    private rerun = new Set<RepoKey>();
    private running = false;
    private halted = false;
    private active = 0;
    private busy = 0;
    private sensitive: string[] = [];
    private readonly limiter: HourlyWriteLimiter;
    private readonly changed = new vscode.EventEmitter<void>();

    /** Fires when queue, activity or status may have changed. */
    readonly onDidChange = this.changed.event;

    private readonly slots: WorkSlots = {
        tryAcquire: () => {
            if (this.active >= readConfig().maxConcurrentIssues) { return false; }
            this.active++;
            return true;
        },
        release: () => { this.active = Math.max(0, this.active - 1); },
    };

    constructor(private readonly deps: ControllerDeps) {
        deps.stampManager.contentFilter = (text) => this.redact(text);
        this.limiter = new HourlyWriteLimiter(limitsFor(readConfig()));
    }

    get isRunning(): boolean { return this.running; }
    get isHalted(): boolean { return this.halted; }

    get status(): ControllerStatus {
        if (this.halted) { return 'halted'; }
        if (!this.running) { return 'stopped'; }
        return this.busy > 0 ? 'polling' : 'idle';
    }

    // ─── Lifecycle ─────────────────────────────────────────────────

    async start(): Promise<void> {
        if (this.running) { return; }
        this.halted = false;
        this.running = true;
        this.abort = new AbortController();
        await this.refreshSensitiveStrings();
        this.syncPipelines();
        for (const key of this.pipelines.keys()) {
            this.schedule(key, 0);
        }
        this.deps.logger.info(`Argus started for ${this.pipelines.size} repo(s)`);
        this.changed.fire();
    }

    /** Stop scheduling and abort anything in flight. */
    stop(reason = 'stopped by user'): void {
        this.running = false;
        for (const timer of this.timers.values()) { clearTimeout(timer); }
        this.timers.clear();
        this.abort.abort(reason);
        this.manualAbort.abort(reason);
        this.rerun.clear();
        this.deps.logger.info(`Argus stopped (${reason})`);
        this.changed.fire();
    }

    /** Stop, and block every forge write until the next Start. */
    async emergencyStop(): Promise<void> {
        this.halted = true;
        this.stop('emergency stop');
        await this.deps.auditLog.append({
            action: 'emergency_stop',
            repo: 'all',
            target: 'all',
            input: '',
            output: '',
            decision: 'Emergency stop triggered by user',
            llmCallCount: 0,
            details: 'All in-flight work aborted; forge writes blocked until restart',
        });
        void this.deps.notifier.notify('emergencyStop', undefined, {
            title: 'Argus was emergency stopped',
            detail: 'All in-flight work was aborted. Writes are blocked until Argus is started again.',
        });
        this.changed.fire();
    }

    /** Run one cycle for every repo now (skipping repos already mid-cycle). */
    async pollNow(): Promise<void> {
        if (this.halted) {
            throw new Error('Argus is halted after an emergency stop. Start it again first.');
        }
        await this.refreshSensitiveStrings();
        this.syncPipelines();
        if (!this.running && this.manualAbort.signal.aborted) {
            this.manualAbort = new AbortController();
        }
        const signal = this.running ? this.abort.signal : this.manualAbort.signal;
        await Promise.all([...this.pipelines.values()].map((p) => this.runOne(p, signal)));
    }

    /** Apply changed settings: repos added/removed, intervals, limits. */
    reload(): void {
        // configure() keeps the history, so changing a limit never refills the budget.
        this.limiter.configure(limitsFor(readConfig()));
        const before = new Set(this.pipelines.keys());
        this.syncPipelines();
        if (this.running) {
            for (const key of before) {
                if (!this.pipelines.has(key)) {
                    clearTimeout(this.timers.get(key));
                    this.timers.delete(key);
                }
            }
            for (const key of this.pipelines.keys()) {
                if (!this.timers.has(key)) { this.schedule(key, 0); }
            }
        }
        this.changed.fire();
    }

    /** Drop cached forge clients (token changed). */
    invalidateForges(): void {
        this.forges.clear();
        for (const [key, p] of [...this.pipelines]) {
            if (!p.isRunning) { this.pipelines.delete(key); }
        }
        this.syncPipelines();
    }

    async forgetRepo(repo: RepoConfig): Promise<void> {
        await this.deps.store.clear(repoKey(repo));
        this.reload();
    }

    dispose(): void {
        this.stop('extension deactivated');
        this.changed.dispose();
    }

    /** Stop and wait (briefly) for in-flight cycles to abort and save their state. */
    async shutdown(timeoutMs = 5000): Promise<void> {
        this.stop('extension deactivated');
        const pending = Promise.allSettled([...this.inflight]);
        await Promise.race([pending, new Promise((r) => setTimeout(r, timeoutMs))]);
        this.changed.dispose();
    }

    // ─── Queries & queue commands ──────────────────────────────────

    getQueue(): TrackedIssue[] {
        return [...this.syncPipelines().values()].flatMap((p) => [...p.getQueue()]);
    }

    getActivity(limit = 50): readonly ActivityEntry[] {
        return this.deps.store.getActivity(limit);
    }

    /** Forge for a configured repo (guarded), for commands like token validation. */
    async forgeFor(repo: RepoConfig): Promise<Forge> {
        return this.getForge(repo);
    }

    async processIssue(repo: RepoConfig, issueNumber: number): Promise<TrackedIssue> {
        const pipeline = await this.pipelineFor(repo);
        const tracked = await pipeline.enqueueIssueNumber(issueNumber);
        this.changed.fire();
        this.kick(pipeline.key);
        return tracked;
    }

    async skip(issue: TrackedIssue): Promise<boolean> {
        return this.withPipeline(issue, (p) => p.setState(issue.issueNumber, 'skipped'));
    }

    async reprocess(issue: TrackedIssue): Promise<boolean> {
        const ok = await this.withPipeline(issue, (p) => p.setState(issue.issueNumber, 'pending'));
        if (ok) { this.kick(issue.repo); }
        return ok;
    }

    async promote(issue: TrackedIssue): Promise<boolean> {
        return this.withPipeline(issue, (p) => p.promote(issue.issueNumber));
    }

    async clearPending(): Promise<number> {
        let removed = 0;
        for (const p of this.syncPipelines().values()) { removed += await p.clearPending(); }
        this.changed.fire();
        return removed;
    }

    // ─── Internals ─────────────────────────────────────────────────

    private async withPipeline(issue: TrackedIssue, fn: (p: RepoPipeline) => Promise<boolean>): Promise<boolean> {
        const pipeline = this.syncPipelines().get(issue.repo);
        if (!pipeline) { return false; }
        const ok = await fn(pipeline);
        this.changed.fire();
        return ok;
    }

    private async pipelineFor(repo: RepoConfig): Promise<RepoPipeline> {
        const pipeline = this.syncPipelines().get(repoKey(repo));
        if (!pipeline) { throw new Error(`${formatRepoString(repo)} is not configured`); }
        return pipeline;
    }

    /**
     * Make `pipelines` match the configured repos. Forges are created lazily
     * on first cycle, so this is cheap and synchronous.
     */
    private syncPipelines(): Map<RepoKey, RepoPipeline> {
        const repos = readConfig().repos;
        const wanted = new Set(repos.map(repoKey));
        for (const key of [...this.pipelines.keys()]) {
            if (!wanted.has(key)) { this.pipelines.delete(key); }
        }
        for (const repo of repos) {
            const key = repoKey(repo);
            const existing = this.pipelines.get(key);
            // Repo settings (host, interval) changed: replace the pipeline once it's idle.
            if (existing && !existing.isRunning && JSON.stringify(existing.repo) !== JSON.stringify(repo)) {
                this.pipelines.delete(key);
                this.forges.delete(key);
            }
            if (!this.pipelines.has(key)) {
                this.pipelines.set(key, new RepoPipeline(repo, this.lazyForge(repo), {
                    ...this.deps,
                    slots: this.slots,
                    writeBudget: (kind) => this.limiter.remaining(kind),
                }));
            }
        }
        return this.pipelines;
    }

    /**
     * A Forge proxy that resolves the real (guarded) forge on first use, so
     * pipelines can exist before tokens are read from SecretStorage.
     */
    private lazyForge(repo: RepoConfig): Forge {
        // Resolved on every call: getForge() caches successes in `forges`, so a token
        // change (invalidateForges) or a transient SecretStorage failure doesn't stick.
        const base = { platform: repo.forge, owner: repo.owner, repo: repo.repo };
        return new Proxy(base as Forge, {
            get: (target, prop, receiver) => {
                if (prop in target) { return Reflect.get(target, prop, receiver); }
                if (prop === 'then' || typeof prop === 'symbol') { return undefined; }
                return async (...args: unknown[]) => {
                    const forge = await this.getForge(repo);
                    const fn = (forge as unknown as Record<string | symbol, unknown>)[prop];
                    if (typeof fn !== 'function') { throw new Error(`Forge has no method ${String(prop)}`); }
                    return (fn as (...a: unknown[]) => unknown).apply(forge, args);
                };
            },
        });
    }

    private async getForge(repo: RepoConfig): Promise<Forge> {
        const key = repoKey(repo);
        let forge = this.forges.get(key);
        if (!forge) {
            const inner = await createForge(repo, this.deps.secrets);
            forge = new GuardedForge(inner, {
                isDryRun: () => readConfig().dryRun,
                isHalted: () => this.halted,
                redact: (text) => this.redact(text),
                limiter: this.limiter,
                logger: this.deps.logger,
            });
            this.forges.set(key, forge);
        }
        return forge;
    }

    /** Run a repo's next cycle as soon as possible (after the current one, if running). */
    private kick(key: RepoKey): void {
        if (!this.running) { return; }
        if (this.pipelines.get(key)?.isRunning) {
            this.rerun.add(key);
        } else {
            this.schedule(key, 0);
        }
    }

    private schedule(key: RepoKey, delayMs: number): void {
        clearTimeout(this.timers.get(key));
        const timer = setTimeout(() => { void this.tick(key); }, delayMs);
        this.timers.set(key, timer);
    }

    private async tick(key: RepoKey): Promise<void> {
        this.timers.delete(key);
        if (!this.running) { return; }
        const pipeline = this.syncPipelines().get(key);
        if (!pipeline) { return; }

        await this.runOne(pipeline, this.abort.signal);

        if (this.running && this.pipelines.has(key) && !this.timers.has(key)) {
            const cfg = readConfig();
            const minutes = cfg.repos.find((r) => repoKey(r) === key)?.pollIntervalMinutes ?? cfg.defaultPollIntervalMinutes;
            this.schedule(key, this.rerun.delete(key) ? 0 : Math.max(1, minutes) * 60_000);
        }
    }

    private runOne(pipeline: RepoPipeline, signal: AbortSignal): Promise<void> {
        const run = this.runCycle(pipeline, signal);
        this.inflight.add(run);
        return run.finally(() => this.inflight.delete(run));
    }

    private async runCycle(pipeline: RepoPipeline, signal: AbortSignal): Promise<void> {
        this.busy++;
        this.changed.fire();
        try {
            const result = await pipeline.runCycle(signal);
            if (result.processed) {
                this.deps.logger.info(`${pipeline.key}: #${result.processed.issueNumber} → ${result.processed.state}`);
            }
        } catch (err) {
            if (isAbortError(err)) {
                this.deps.logger.info(`${pipeline.key}: cycle aborted`);
            } else {
                this.deps.logger.error(`${pipeline.key}: cycle failed: ${err}`);
                void this.deps.notifier.notify('systemError', pipeline.key, {
                    title: `Poll cycle failed for ${pipeline.key}`,
                    detail: err instanceof Error ? err.message : String(err),
                });
            }
        } finally {
            this.busy--;
            this.changed.fire();
        }
    }

    private async refreshSensitiveStrings(): Promise<void> {
        try {
            this.sensitive = (await this.deps.llm.sensitiveStrings()).filter((s) => s.length >= 4);
        } catch {
            this.sensitive = [];
        }
    }

    /** Remove strings that must never be published (e.g. the Claude account email). */
    private redact(text: string): string {
        let out = text;
        for (const s of this.sensitive) {
            out = out.replace(new RegExp(escapeRegExp(s), 'gi'), '[redacted]');
        }
        return out;
    }
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function limitsFor(cfg: ArgusConfig): ConstructorParameters<typeof HourlyWriteLimiter>[0] {
    const r = cfg.rateLimits;
    return {
        comment: { limit: r.commentsPerHour, windowMs: HOUR, setting: 'argus.rateLimits.commentsPerHour' },
        branch: { limit: r.branchesPerHour, windowMs: HOUR, setting: 'argus.rateLimits.branchesPerHour' },
        pr: { limit: r.prsPerHour, windowMs: HOUR, setting: 'argus.rateLimits.prsPerHour' },
        push: { limit: r.pushesPerHour, windowMs: HOUR, setting: 'argus.rateLimits.pushesPerHour' },
        block: { limit: r.blocksPerDay, windowMs: 24 * HOUR, setting: 'argus.rateLimits.blocksPerDay' },
        // Statuses, labels and deletes ride along with other work; cap them generously.
        status: { limit: Math.max(60, r.commentsPerHour * 4), windowMs: HOUR },
        label: { limit: Math.max(60, r.commentsPerHour * 4), windowMs: HOUR },
        delete: { limit: Math.max(10, r.commentsPerHour), windowMs: HOUR },
    };
}
