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
 */

import * as vscode from 'vscode';
import type { Pipeline } from '../agent/pipeline';
import type { TrackedIssue, ActivityEntry, RepoStats, IssueState } from '../agent/types';
import type { AuditLog } from '../crypto/audit';

// ─── State → Icon mapping ───────────────────────────────────────────

const STATE_ICONS: Record<IssueState, string> = {
    pending: '$(clock)',
    evaluating: '$(search)',
    approved: '$(check)',
    rejected: '$(x)',
    branching: '$(git-branch)',
    coding: '$(code)',
    'waiting-ci': '$(loading~spin)',
    iterating: '$(sync~spin)',
    'pr-open': '$(git-pull-request)',
    'analyzing-competing': '$(diff)',
    synthesizing: '$(beaker)',
    stuck: '$(warning)',
    flagged: '$(shield)',
    done: '$(pass-filled)',
    skipped: '$(circle-slash)',
};

// ─── Work Queue ─────────────────────────────────────────────────────

export class WorkQueueProvider implements vscode.TreeDataProvider<TrackedIssue> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TrackedIssue | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly pipeline: Pipeline) {}

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(item: TrackedIssue): vscode.TreeItem {
        const ti = new vscode.TreeItem(
            `#${item.issueNumber} ${item.title}`,
            vscode.TreeItemCollapsibleState.None,
        );
        ti.description = item.state;
        ti.iconPath = new vscode.ThemeIcon(STATE_ICONS[item.state]?.replace('$(', '').replace(')', '') || 'circle-outline');
        ti.tooltip = new vscode.MarkdownString(
            `**#${item.issueNumber}** ${item.title}\n\n` +
            `State: ${item.state}\n` +
            `Iteration: ${item.currentIteration}/${item.maxIterations}\n` +
            (item.prUrl ? `PR: [#${item.prNumber}](${item.prUrl})\n` : '') +
            (item.error ? `\n⚠️ ${item.error}` : '')
        );
        if (item.url) {
            ti.command = {
                command: 'vscode.open',
                title: 'Open Issue',
                arguments: [vscode.Uri.parse(item.url)],
            };
        }
        ti.contextValue = `argus.issue.${item.state}`;
        return ti;
    }

    getChildren(): TrackedIssue[] {
        return [...this.pipeline.getWorkQueue()].sort((a, b) => {
            // Active items first, then by creation date
            const stateOrder: Record<string, number> = {
                coding: 0, iterating: 0, evaluating: 0, branching: 0,
                'waiting-ci': 1, 'analyzing-competing': 1, synthesizing: 1,
                'pr-open': 2, pending: 3, approved: 3,
                stuck: 4, flagged: 4,
                done: 5, rejected: 5, skipped: 5,
            };
            const aOrder = stateOrder[a.state] ?? 3;
            const bOrder = stateOrder[b.state] ?? 3;
            if (aOrder !== bOrder) { return aOrder - bOrder; }
            return b.createdAt.getTime() - a.createdAt.getTime();
        });
    }
}

// ─── Recent Activity ────────────────────────────────────────────────

export class ActivityProvider implements vscode.TreeDataProvider<ActivityEntry> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ActivityEntry | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly pipeline: Pipeline) {}

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(entry: ActivityEntry): vscode.TreeItem {
        const timeAgo = this.formatTimeAgo(entry.timestamp);
        const ti = new vscode.TreeItem(
            `${entry.icon} ${entry.message}`,
            vscode.TreeItemCollapsibleState.None,
        );
        ti.description = timeAgo;
        ti.tooltip = new vscode.MarkdownString(
            `${entry.icon} ${entry.message}\n\n` +
            `Repo: ${entry.repo}\n` +
            `Time: ${entry.timestamp.toLocaleString()}\n` +
            (entry.url ? `[Open](${entry.url})` : '')
        );
        if (entry.url) {
            ti.command = {
                command: 'vscode.open',
                title: 'Open',
                arguments: [vscode.Uri.parse(entry.url)],
            };
        }
        return ti;
    }

    getChildren(): ActivityEntry[] {
        return [...this.pipeline.getActivity(50)].reverse();
    }

    private formatTimeAgo(date: Date): string {
        const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
        if (seconds < 60) { return `${seconds}s ago`; }
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) { return `${minutes}m ago`; }
        const hours = Math.floor(minutes / 60);
        if (hours < 24) { return `${hours}h ago`; }
        return `${Math.floor(hours / 24)}d ago`;
    }
}

// ─── Repository Stats ───────────────────────────────────────────────

interface StatsItem {
    label: string;
    value: string;
    repo?: string;
}

export class RepoStatsProvider implements vscode.TreeDataProvider<StatsItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<StatsItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private stats: RepoStats[] = [];

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    updateStats(stats: RepoStats[]): void {
        this.stats = stats;
        this.refresh();
    }

    getTreeItem(item: StatsItem): vscode.TreeItem {
        const ti = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
        ti.description = item.value;
        if (item.repo) {
            ti.tooltip = `Repository: ${item.repo}`;
        }
        return ti;
    }

    getChildren(): StatsItem[] {
        if (this.stats.length === 0) {
            return [{ label: 'No repositories configured', value: '' }];
        }
        const items: StatsItem[] = [];
        for (const stat of this.stats) {
            items.push({ label: `📦 ${stat.repo}`, value: '', repo: stat.repo });
            items.push({ label: '  Issues triaged', value: String(stat.argusTriaged), repo: stat.repo });
            items.push({ label: '  PRs opened', value: String(stat.prsOpened), repo: stat.repo });
            items.push({ label: '  PRs merged (human)', value: String(stat.prsMergedByHumans), repo: stat.repo });
            items.push({ label: '  Rejection rate', value: `${(stat.rejectionRate * 100).toFixed(0)}%`, repo: stat.repo });
            items.push({ label: '  Threat detections', value: String(stat.threatDetections), repo: stat.repo });
        }
        return items;
    }
}

// ─── Security Monitor ───────────────────────────────────────────────

interface SecurityItem {
    label: string;
    detail: string;
    severity?: 'info' | 'warn' | 'error';
}

export class SecurityProvider implements vscode.TreeDataProvider<SecurityItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SecurityItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private items: SecurityItem[] = [];

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    addThreatEvent(label: string, detail: string, severity: 'info' | 'warn' | 'error'): void {
        this.items.unshift({ label, detail, severity });
        if (this.items.length > 100) { this.items = this.items.slice(0, 100); }
        this.refresh();
    }

    getTreeItem(item: SecurityItem): vscode.TreeItem {
        const icon = item.severity === 'error' ? '$(error)' :
                     item.severity === 'warn' ? '$(warning)' : '$(info)';
        const ti = new vscode.TreeItem(
            `${icon.replace('$(', '').replace(')', '')} ${item.label}`,
            vscode.TreeItemCollapsibleState.None,
        );
        ti.description = item.detail;
        ti.iconPath = new vscode.ThemeIcon(
            item.severity === 'error' ? 'error' :
            item.severity === 'warn' ? 'warning' : 'info',
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

interface HealthItem {
    label: string;
    value: string;
    status: 'ok' | 'warning' | 'error';
}

export class SystemHealthProvider implements vscode.TreeDataProvider<HealthItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<HealthItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private items: HealthItem[] = [];

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    updateHealth(items: HealthItem[]): void {
        this.items = items;
        this.refresh();
    }

    getTreeItem(item: HealthItem): vscode.TreeItem {
        const ti = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
        ti.description = item.value;
        ti.iconPath = new vscode.ThemeIcon(
            item.status === 'ok' ? 'pass' :
            item.status === 'warning' ? 'warning' : 'error',
            item.status === 'ok' ? new vscode.ThemeColor('testing.iconPassed') :
            item.status === 'warning' ? new vscode.ThemeColor('testing.iconQueued') :
            new vscode.ThemeColor('testing.iconFailed'),
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
