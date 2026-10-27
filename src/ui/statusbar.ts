// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Status bar — shows Argus status at a glance.
 */

import * as vscode from 'vscode';

export type ArgusStatus = 'idle' | 'polling' | 'processing' | 'error' | 'stopped';

/** Longest detail shown in the bar itself; the tooltip carries the rest. */
const MAX_TEXT_DETAIL = 40;

export class StatusBar implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private status: ArgusStatus = 'stopped';
    private detail?: string;
    private processing = 0;

    constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.item.command = 'argus.showActivityLog';
        this.setStatus('stopped');
        this.item.show();
    }

    setStatus(status: ArgusStatus, detail?: string): void {
        this.status = status;
        this.detail = detail ? oneLine(detail) : undefined;
        this.render();
    }

    /** Overrides the text with an active count while > 0; 0 restores the status. */
    setProcessingCount(count: number): void {
        this.processing = Math.max(0, Math.floor(count));
        this.render();
    }

    private render(): void {
        const short = this.detail ? escapeIcons(truncate(this.detail, MAX_TEXT_DETAIL)) : undefined;
        this.item.backgroundColor = undefined;
        switch (this.status) {
            case 'idle':
                this.item.text = '$(eye) Argus: Idle';
                break;
            case 'polling':
                this.item.text = '$(sync~spin) Argus: Polling';
                break;
            case 'processing':
                this.item.text = `$(loading~spin) Argus: ${short ?? 'Processing'}`;
                break;
            case 'error':
                this.item.text = `$(error) Argus: ${short ?? 'Error'}`;
                this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                break;
            case 'stopped':
                this.item.text = '$(debug-stop) Argus: Stopped';
                break;
        }
        if (this.processing > 0 && this.status !== 'error' && this.status !== 'stopped') {
            this.item.text = `$(loading~spin) Argus: ${this.processing} active`;
        }
        this.item.tooltip = `Argus Issue Agent — ${this.status}${this.detail ? `: ${this.detail}` : ''}`;
    }

    dispose(): void {
        this.item.dispose();
    }
}

function oneLine(s: string): string {
    return s.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function truncate(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Keep `$(name)` in detail text from rendering as an icon. */
function escapeIcons(s: string): string {
    return s.replace(/\$\(/g, '$​(');
}
