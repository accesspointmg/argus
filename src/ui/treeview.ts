// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * TreeView providers for the Argus sidebar panel.
 *
 * Five views:
 *  1. Work Queue     — tracked issues with state icons
 *  2. Recent Activity — chronological activity feed
 *  3. Repo Stats     — per-repo metrics
 *  4. Security       — threat detections & trust info
 *  5. System Health  — polling status, LLM availability, key rotation
 *
 * Issue titles and activity messages are attacker-controlled. Tooltips add
 * them with `appendText` (escaped markdown), and only http(s) URLs become
 * click targets.
 */

import * as vscode from 'vscode';
import type { TrackedIssue, ActivityEntry, RepoStats, IssueState } from '../agent/types';

// ─── Data sources (narrow, so the pipeline can change shape) ────────

/** Where the Work Queue view gets its items (all repos). */
export interface WorkQueueSource {
    getQueue(): readonly TrackedIssue[];
}

/** Where the Activity view gets its items, oldest first. */
export interface ActivitySource {
    getActivity(limit?: number): readonly ActivityEntry[];
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Dates may arrive as strings/numbers once state is persisted as JSON. */
function toTime(d: Date | string | number | undefined): number {
    if (d === undefined) { return 0; }
    const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
    return Number.isFinite(t) ? t : 0;
}

function webUri(url: string | undefined): vscode.Uri | undefined {
    if (!url) { return undefined; }
    try {
        const u = vscode.Uri.parse(url, true);
        return u.scheme === 'https' || u.scheme === 'http' ? u : undefined;
    } catch {
        return undefined;
    }
}

function openCommand(uri: vscode.Uri | undefined, title: string): vscode.Command | undefined {
    return uri ? { command: 'vscode.open', title, arguments: [uri] } : undefined;
}

function oneLine(s: string, max = 200): string {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

abstract class RefreshableProvider<T> implements vscode.TreeDataProvider<T>, vscode.Disposable {
    protected readonly changed = new vscode.EventEmitter<T | undefined>();
    readonly onDidChangeTreeData = this.changed.event;

    refresh(): void {
        this.changed.fire(undefined);
    }

    dispose(): void {
        this.changed.dispose();
    }

    abstract getTreeItem(element: T): vscode.TreeItem;
    abstract getChildren(element?: T): T[];
}

// ─── Work Queue ─────────────────────────────────────────────────────

/** Codicon per state. */
const STATE_ICONS: Record<IssueState, string> = {
    pending: 'clock',
    evaluating: 'search',
    'awaiting-approval': 'account',
    approved: 'check',
    rejected: 'x',
    branching: 'git-branch',
    coding: 'code',
    'waiting-ci': 'loading~spin',
    iterating: 'sync~spin',
    'pr-open': 'git-pull-request',
    'analyzing-competing': 'diff',
    synthesizing: 'beaker',
    stuck: 'warning',
    flagged: 'shield',
    done: 'pass-filled',
    skipped: 'circle-slash',
};

/** Sort rank: active work first, finished last. */
const STATE_ORDER: Record<IssueState, number> = {
    coding: 0, iterating: 0, evaluating: 0, branching: 0,
    'waiting-ci': 1, 'analyzing-competing': 1, synthesizing: 1,
    'pr-open': 2, pending: 3, approved: 3, 'awaiting-approval': 3,
    stuck: 4, flagged: 4,
    done: 5, rejected: 5, skipped: 5,
};

export class WorkQueueProvider extends RefreshableProvider<TrackedIssue> {
    /** Show the repo next to each item when the queue spans several. */
    private multiRepo = false;

    constructor(private readonly source: WorkQueueSource) {
        super();
    }

    getTreeItem(item: TrackedIssue): vscode.TreeItem {
        const ti = new vscode.TreeItem(
            `#${item.issueNumber} ${oneLine(item.title, 120)}`,
            vscode.TreeItemCollapsibleState.None,
        );
        ti.description = this.multiRepo ? `${item.state} · ${item.repo}` : item.state;
        ti.iconPath = new vscode.ThemeIcon(STATE_ICONS[item.state] ?? 'circle-outline');

        // supportThemeIcons up front so appendText also escapes `$(icon)` in titles.
        const md = new vscode.MarkdownString(undefined, true);
        md.appendMarkdown(`**#${item.issueNumber}** `);
        md.appendText(oneLine(item.title, 300));
        md.appendMarkdown('\n\n');
        md.appendText(`Repo: ${item.repo}\nState: ${item.state}\nIteration: ${item.currentIteration}/${item.maxIterations}\n`);
        if (item.prNumber !== undefined) {
            md.appendText(`PR: #${item.prNumber}${item.prUrl ? ` ${item.prUrl}` : ''}\n`);
        }
        if (item.error) {
            md.appendMarkdown('\n\n$(warning) ');
            md.appendText(oneLine(item.error, 500));
        }
        ti.tooltip = md;

        ti.command = openCommand(webUri(item.url), 'Open Issue');
        ti.contextValue = `argus.issue.${item.state}`;
        return ti;
    }

    getChildren(): TrackedIssue[] {
        const queue = this.source.getQueue();
        this.multiRepo = new Set(queue.map((i) => i.repo)).size > 1;
        return [...queue].sort((a, b) => {
            const aOrder = STATE_ORDER[a.state] ?? 3;
            const bOrder = STATE_ORDER[b.state] ?? 3;
            if (aOrder !== bOrder) { return aOrder - bOrder; }
            return toTime(b.createdAt) - toTime(a.createdAt);
        });
    }
}

// ─── Recent Activity ────────────────────────────────────────────────

const ACTIVITY_LIMIT = 50;

export class ActivityProvider extends RefreshableProvider<ActivityEntry> {
    constructor(private readonly source: ActivitySource) {
        super();
    }

    getTreeItem(entry: ActivityEntry): vscode.TreeItem {
        const when = toTime(entry.timestamp);
        const ti = new vscode.TreeItem(
            `${entry.icon} ${oneLine(entry.message, 150)}`,
            vscode.TreeItemCollapsibleState.None,
        );
        ti.description = formatTimeAgo(when);
        const md = new vscode.MarkdownString(undefined, true);
        md.appendText(`${entry.icon} ${oneLine(entry.message, 500)}\n\nRepo: ${entry.repo}\nTime: ${new Date(when).toLocaleString()}`);
        ti.tooltip = md;
        ti.command = openCommand(webUri(entry.url), 'Open');
        return ti;
    }

    getChildren(): ActivityEntry[] {
        return [...this.source.getActivity(ACTIVITY_LIMIT)].reverse();
    }
}

function formatTimeAgo(time: number): string {
    if (!time) { return ''; }
    const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
    if (seconds < 60) { return `${seconds}s ago`; }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) { return `${minutes}m ago`; }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) { return `${hours}h ago`; }
    return `${Math.floor(hours / 24)}d ago`;
}

// ─── Repository Stats ───────────────────────────────────────────────

export interface StatsItem {
    label: string;
    value: string;
    repo?: string;
    children?: StatsItem[];
}

export class RepoStatsProvider extends RefreshableProvider<StatsItem> {
    private stats: RepoStats[] = [];

    updateStats(stats: RepoStats[]): void {
        this.stats = stats;
        this.refresh();
    }

    getTreeItem(item: StatsItem): vscode.TreeItem {
        const ti = new vscode.TreeItem(
            item.label,
            item.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
        );
        ti.description = item.value;
        if (item.children) { ti.iconPath = new vscode.ThemeIcon('repo'); }
        if (item.repo) { ti.tooltip = `Repository: ${item.repo}`; }
        return ti;
    }

    getChildren(element?: StatsItem): StatsItem[] {
        if (element) { return element.children ?? []; }
        if (this.stats.length === 0) {
            return [{ label: 'No repositories configured', value: '' }];
        }
        return this.stats.map((s) => ({
            label: s.repo,
            value: '',
            repo: s.repo,
            children: [
                { label: 'Issues triaged', value: String(s.argusTriaged), repo: s.repo },
                { label: 'PRs opened', value: String(s.prsOpened), repo: s.repo },
                { label: 'PRs merged (human)', value: String(s.prsMergedByHumans), repo: s.repo },
                { label: 'Rejection rate', value: `${(s.rejectionRate * 100).toFixed(0)}%`, repo: s.repo },
                { label: 'Threat detections', value: String(s.threatDetections), repo: s.repo },
            ],
        }));
    }
}

// ─── Security Monitor ───────────────────────────────────────────────

export type Severity = 'info' | 'warn' | 'error';

export interface SecurityItem {
    label: string;
    detail: string;
    severity?: Severity;
}

const MAX_SECURITY_ITEMS = 100;

export class SecurityProvider extends RefreshableProvider<SecurityItem> {
    private items: SecurityItem[] = [];

    addThreatEvent(label: string, detail: string, severity: Severity): void {
        this.items.unshift({ label: oneLine(label, 150), detail: oneLine(detail, 200), severity });
        if (this.items.length > MAX_SECURITY_ITEMS) { this.items.length = MAX_SECURITY_ITEMS; }
        this.refresh();
    }

    getTreeItem(item: SecurityItem): vscode.TreeItem {
        const ti = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
        ti.description = item.detail;
        ti.tooltip = item.detail ? `${item.label}\n${item.detail}` : item.label;
        ti.iconPath = new vscode.ThemeIcon(
            item.severity === 'error' ? 'error' : item.severity === 'warn' ? 'warning' : 'info',
        );
        return ti;
    }

    getChildren(): SecurityItem[] {
        if (this.items.length === 0) {
            return [{ label: 'No security events', detail: 'All clear' }];
        }
        return this.items;
    }
}

// ─── System Health ──────────────────────────────────────────────────

export interface HealthItem {
    label: string;
    value: string;
    status: 'ok' | 'warning' | 'error';
}

export class SystemHealthProvider extends RefreshableProvider<HealthItem> {
    private items: HealthItem[] = [];

    updateHealth(items: HealthItem[]): void {
        this.items = items;
        this.refresh();
    }

    getTreeItem(item: HealthItem): vscode.TreeItem {
        const ti = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
        ti.description = item.value;
        ti.iconPath = new vscode.ThemeIcon(
            item.status === 'ok' ? 'pass' : item.status === 'warning' ? 'warning' : 'error',
            new vscode.ThemeColor(
                item.status === 'ok' ? 'testing.iconPassed' :
                item.status === 'warning' ? 'testing.iconQueued' : 'testing.iconFailed',
            ),
        );
        return ti;
    }

    getChildren(): HealthItem[] {
        if (this.items.length === 0) {
            return [{ label: 'Not started', value: '', status: 'warning' }];
        }
        return this.items;
    }
}
