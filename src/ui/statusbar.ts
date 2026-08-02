// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Status bar — shows Argus status at a glance.
 */

import * as vscode from 'vscode';

export type ArgusStatus = 'idle' | 'polling' | 'processing' | 'error' | 'stopped';

export class StatusBar {
    private item: vscode.StatusBarItem;

    constructor() {
        this.item = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100,
        );
        this.item.command = 'argus.showActivityLog';
        this.setStatus('stopped');
        this.item.show();
    }

    setStatus(status: ArgusStatus, detail?: string): void {
        switch (status) {
            case 'idle':
                this.item.text = '$(eye) Argus: Idle';
                this.item.backgroundColor = undefined;
                break;
            case 'polling':
                this.item.text = '$(sync~spin) Argus: Polling';
                this.item.backgroundColor = undefined;
                break;
            case 'processing':
                this.item.text = `$(loading~spin) Argus: ${detail || 'Processing'}`;
                this.item.backgroundColor = undefined;
                break;
            case 'error':
                this.item.text = `$(error) Argus: ${detail || 'Error'}`;
                this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                break;
            case 'stopped':
                this.item.text = '$(debug-stop) Argus: Stopped';
                this.item.backgroundColor = undefined;
                break;
        }

        this.item.tooltip = `Argus Issue Agent — ${status}${detail ? `: ${detail}` : ''}`;
    }

    setProcessingCount(count: number): void {
        if (count > 0) {
            this.item.text = `$(loading~spin) Argus: ${count} active`;
        }
    }

    dispose(): void {
        this.item.dispose();
    }
}
