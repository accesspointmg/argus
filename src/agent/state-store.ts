// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Persisted pipeline state.
 *
 * Before this existed everything lived in memory, so a window reload re-ran
 * the last day of issues, re-posted loop comments and duplicated threat
 * assessments. State is stored per repo in `globalState` (Argus is a
 * user-level background agent, not tied to a workspace) and written after
 * every change. Dates are stored as ISO strings and revived on load.
 */

import type * as vscode from 'vscode';
import type { RepoKey } from '../forge/types';
import type { ActivityEntry, IssueState, TrackedIssue } from './types';

const STORAGE_PREFIX = 'argus.state.v2:';
const ACTIVITY_KEY = 'argus.activity.v2';
const ACTIVITY_LIMIT = 300;

/** Terminal states: the issue will not be picked up again unless a user asks. */
export const FINAL_STATES: readonly IssueState[] = ['done', 'rejected', 'skipped', 'flagged', 'stuck'];

/** How long finished issues stay visible in the queue before being archived. */
const FINISHED_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** How long an untrusted issue waits for a trusted `/argus fix` before it is dropped. */
const APPROVAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Upper bound on remembered issue outcomes per repo. */
const HANDLED_LIMIT = 5000;

export interface AckRecord {
    count: number;
    firstAckAt: string;
    lastAckAt: string;
}

export interface RepoState {
    lastPoll?: string;
    queue: TrackedIssue[];
    /** Issue number → final state, kept after the queue entry is archived. */
    handled: Record<string, IssueState>;
    /** PR number → acknowledgement counter (bounded engagement on our own PRs). */
    acks: Record<string, AckRecord>;
    /** PR numbers where a loop was detected and Argus disengaged. */
    disengaged: number[];
    /** Issue number → ISO time of the last comment-monitoring pass. */
    commentCursor: Record<string, string>;
    /** ISO timestamps of issues started, for `rateLimits.issuesPerHour`. */
    issueStarts: string[];
}

function emptyState(): RepoState {
    return { queue: [], handled: {}, acks: {}, disengaged: [], commentCursor: {}, issueStarts: [] };
}

const DATE_FIELDS: (keyof TrackedIssue)[] = ['createdAt', 'startedAt', 'completedAt', 'bodySeenAt'];

/** States an issue is only in while a cycle is working on it. */
export const ACTIVE_STATES: readonly IssueState[] = [
    'evaluating', 'approved', 'branching', 'coding', 'waiting-ci', 'iterating', 'analyzing-competing', 'synthesizing',
];

function reviveIssue(raw: TrackedIssue): TrackedIssue {
    const issue = { ...raw } as TrackedIssue & Record<string, unknown>;
    for (const field of DATE_FIELDS) {
        const v = issue[field];
        if (typeof v === 'string') {
            (issue as Record<string, unknown>)[field] = new Date(v);
        }
    }
    // Saved mid-cycle (e.g. VS Code closed while coding): nothing is working on it now.
    if (ACTIVE_STATES.includes(issue.state)) {
        issue.state = issue.prNumber ? 'pr-open' : 'pending';
    }
    return issue;
}

export class StateStore {
    private cache = new Map<RepoKey, RepoState>();
    private activity: ActivityEntry[];

    constructor(private readonly memento: vscode.Memento) {
        const raw = memento.get<ActivityEntry[]>(ACTIVITY_KEY, []);
        this.activity = Array.isArray(raw)
            ? raw.map((a) => ({ ...a, timestamp: new Date(a.timestamp) }))
            : [];
    }

    /** Live state object for a repo. Mutate it, then call {@link save}. */
    get(repo: RepoKey): RepoState {
        let state = this.cache.get(repo);
        if (!state) {
            const raw = this.memento.get<Partial<RepoState>>(STORAGE_PREFIX + repo);
            state = { ...emptyState(), ...(raw ?? {}) };
            state.queue = (state.queue ?? []).map(reviveIssue);
            this.cache.set(repo, state);
        }
        return state;
    }

    async save(repo: RepoKey): Promise<void> {
        const state = this.get(repo);
        this.compact(state);
        await this.memento.update(STORAGE_PREFIX + repo, state);
    }

    /** Forget everything about a repo (used when it is removed). */
    async clear(repo: RepoKey): Promise<void> {
        this.cache.delete(repo);
        await this.memento.update(STORAGE_PREFIX + repo, undefined);
    }

    addActivity(entry: Omit<ActivityEntry, 'timestamp'>): void {
        this.activity.push({ ...entry, timestamp: new Date() });
        if (this.activity.length > ACTIVITY_LIMIT) {
            this.activity = this.activity.slice(-ACTIVITY_LIMIT);
        }
        void this.memento.update(ACTIVITY_KEY, this.activity);
    }

    getActivity(limit = 50): readonly ActivityEntry[] {
        return this.activity.slice(-limit);
    }

    /** Archive old finished issues and bound the remembered outcomes. */
    private compact(state: RepoState): void {
        const now = Date.now();
        state.queue = state.queue.filter((issue) => {
            // Untrusted issues nobody approved within the window are dropped (can be re-queued by hand).
            if (issue.state === 'awaiting-approval' && now - (issue.startedAt ?? issue.createdAt).getTime() > APPROVAL_WINDOW_MS) {
                state.handled[String(issue.issueNumber)] = 'skipped';
                return false;
            }
            if (!FINAL_STATES.includes(issue.state)) { return true; }
            state.handled[String(issue.issueNumber)] = issue.state;
            const finished = (issue.completedAt ?? issue.startedAt ?? issue.createdAt)?.getTime?.() ?? now;
            return now - finished < FINISHED_RETENTION_MS;
        });

        const handledKeys = Object.keys(state.handled);
        if (handledKeys.length > HANDLED_LIMIT) {
            for (const key of handledKeys.slice(0, handledKeys.length - HANDLED_LIMIT)) {
                delete state.handled[key];
            }
        }

        const hourAgo = now - 60 * 60 * 1000;
        state.issueStarts = state.issueStarts.filter((t) => Date.parse(t) > hourAgo);

        if (state.disengaged.length > 1000) {
            state.disengaged = state.disengaged.slice(-1000);
        }
    }
}
