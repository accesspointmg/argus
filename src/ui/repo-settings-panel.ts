// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Repo Settings webview — configure a single repository's settings
 * (email recipients, SMTP override, poll interval) in a friendly panel.
 */

import * as vscode from 'vscode';
import type { RepoConfig } from '../forge/types';
import { formatRepoString, parseRepoEntry } from '../util/config';

export class RepoSettingsPanel {
    public static readonly viewType = 'argus.repoSettings';
    private static panels = new Map<string, RepoSettingsPanel>();

    private readonly panel: vscode.WebviewPanel;
    private readonly repoKey: string;
    private disposables: vscode.Disposable[] = [];

    /**
     * Show (or re-focus) the settings panel for a specific repo.
     */
    static show(
        extensionUri: vscode.Uri,
        repo: RepoConfig,
        allRepos: (string | Record<string, any>)[],
        onSave: (updated: (string | Record<string, any>)[]) => Promise<void>,
    ): void {
        const key = formatRepoString(repo);
        const existing = RepoSettingsPanel.panels.get(key);
        if (existing) {
            existing.panel.reveal();
            return;
        }
        new RepoSettingsPanel(extensionUri, repo, allRepos, onSave);
    }

    private constructor(
        extensionUri: vscode.Uri,
        private repo: RepoConfig,
        private allRepos: (string | Record<string, any>)[],
        private readonly onSave: (updated: (string | Record<string, any>)[]) => Promise<void>,
    ) {
        this.repoKey = formatRepoString(repo);

        this.panel = vscode.window.createWebviewPanel(
            RepoSettingsPanel.viewType,
            `Repo: ${repo.owner}/${repo.repo}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
            },
        );

        RepoSettingsPanel.panels.set(this.repoKey, this);

        this.panel.iconPath = new vscode.ThemeIcon('repo');
        this.panel.webview.html = this.getHtml();

        this.panel.webview.onDidReceiveMessage(
            async (msg) => {
                switch (msg.command) {
                    case 'save':
                        await this.handleSave(msg.data);
                        break;
                    case 'cancel':
                        this.panel.dispose();
                        break;
                }
            },
            undefined,
            this.disposables,
        );

        this.panel.onDidDispose(() => {
            RepoSettingsPanel.panels.delete(this.repoKey);
            for (const d of this.disposables) { d.dispose(); }
        });
    }

    private async handleSave(data: any): Promise<void> {
        // Build the updated repo entry
        const hasEmail = (data.recipients?.length > 0) || data.smtpHost;
        let updatedEntry: string | Record<string, any>;

        if (hasEmail) {
            const entry: Record<string, any> = {
                repo: formatRepoString(this.repo),
            };
            const email: Record<string, any> = {};
            if (data.recipients && data.recipients.length > 0) {
                email.recipients = data.recipients;
            }
            if (data.smtpHost) {
                email.smtp = {
                    ...(data.smtpHost ? { host: data.smtpHost } : {}),
                    ...(data.smtpPort ? { port: Number(data.smtpPort) } : {}),
                    ...(data.smtpSecure !== undefined ? { secure: data.smtpSecure } : {}),
                    ...(data.smtpUser ? { user: data.smtpUser } : {}),
                };
            }
            entry.email = email;
            updatedEntry = entry;
        } else {
            updatedEntry = formatRepoString(this.repo);
        }

        // Replace this repo's entry in the array
        const targetKey = this.repoKey;
        const updated = this.allRepos.map((r) => {
            const parsed = parseRepoEntry(r);
            if (parsed && formatRepoString(parsed) === targetKey) {
                return updatedEntry;
            }
            return r;
        });

        await this.onSave(updated);
        vscode.window.showInformationMessage(`Settings saved for ${this.repo.owner}/${this.repo.repo}.`);
    }

    private getHtml(): string {
        const email = this.repo.email ?? {};
        const recipients = email.recipients?.join(', ') ?? '';
        const smtpHost = email.smtp?.host ?? '';
        const smtpPort = email.smtp?.port ?? '';
        const smtpSecure = email.smtp?.secure ?? false;
        const smtpUser = email.smtp?.user ?? '';

        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            padding: 20px 28px;
            max-width: 680px;
        }
        h1 {
            font-size: 1.4em;
            font-weight: 600;
            margin: 0 0 4px 0;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .subtitle {
            color: var(--vscode-descriptionForeground);
            margin: 0 0 24px 0;
            font-size: 0.9em;
        }
        .section {
            margin-bottom: 24px;
        }
        .section-title {
            font-size: 1.05em;
            font-weight: 600;
            margin-bottom: 12px;
            padding-bottom: 4px;
            border-bottom: 1px solid var(--vscode-widget-border);
        }
        label {
            display: block;
            font-weight: 500;
            margin-bottom: 4px;
            margin-top: 12px;
        }
        label:first-child {
            margin-top: 0;
        }
        .help {
            color: var(--vscode-descriptionForeground);
            font-size: 0.85em;
            margin: 2px 0 0 0;
        }
        input[type="text"],
        input[type="number"] {
            width: 100%;
            box-sizing: border-box;
            padding: 6px 8px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 2px;
            font-family: inherit;
            font-size: inherit;
        }
        input:focus {
            outline: 1px solid var(--vscode-focusBorder);
            border-color: var(--vscode-focusBorder);
        }
        .checkbox-row {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 12px;
        }
        .checkbox-row input[type="checkbox"] {
            accent-color: var(--vscode-checkbox-background);
        }
        .btn-row {
            display: flex;
            gap: 8px;
            margin-top: 28px;
        }
        button {
            padding: 6px 16px;
            border: none;
            border-radius: 2px;
            font-family: inherit;
            font-size: inherit;
            cursor: pointer;
        }
        .btn-primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-primary:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .row-2col {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
        }
    </style>
</head>
<body>
    <h1>⚙️ ${this.repo.owner}/${this.repo.repo}</h1>
    <p class="subtitle">${this.repo.forge} repository</p>

    <div class="section">
        <div class="section-title">Email Notifications</div>
        <label for="recipients">Recipients</label>
        <input type="text" id="recipients" value="${this.escHtml(recipients)}"
               placeholder="john@example.com, jane@example.com" />
        <p class="help">Comma-separated. Leave blank to use the global default recipients.</p>
    </div>

    <div class="section">
        <div class="section-title">SMTP Override <span style="font-weight:normal; color:var(--vscode-descriptionForeground)">(optional)</span></div>
        <p class="help" style="margin-bottom:8px">Only fill these in if this repo should send email through a different SMTP server. Otherwise, the global Argus SMTP is used.</p>

        <div class="row-2col">
            <div>
                <label for="smtpHost">SMTP Host</label>
                <input type="text" id="smtpHost" value="${this.escHtml(smtpHost)}" placeholder="smtp.example.com" />
            </div>
            <div>
                <label for="smtpPort">Port</label>
                <input type="number" id="smtpPort" value="${smtpPort}" placeholder="587" />
            </div>
        </div>

        <label for="smtpUser">SMTP User</label>
        <input type="text" id="smtpUser" value="${this.escHtml(smtpUser)}" placeholder="alerts@example.com" />

        <div class="checkbox-row">
            <input type="checkbox" id="smtpSecure" ${smtpSecure ? 'checked' : ''} />
            <label for="smtpSecure" style="margin:0">Use SSL (port 465)</label>
        </div>
    </div>

    <div class="btn-row">
        <button class="btn-primary" onclick="save()">Save</button>
        <button class="btn-secondary" onclick="cancel()">Cancel</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function save() {
            const recipientsRaw = document.getElementById('recipients').value.trim();
            const recipients = recipientsRaw
                ? recipientsRaw.split(',').map(s => s.trim()).filter(Boolean)
                : [];

            vscode.postMessage({
                command: 'save',
                data: {
                    recipients,
                    smtpHost: document.getElementById('smtpHost').value.trim(),
                    smtpPort: document.getElementById('smtpPort').value.trim(),
                    smtpSecure: document.getElementById('smtpSecure').checked,
                    smtpUser: document.getElementById('smtpUser').value.trim(),
                },
            });
        }

        function cancel() {
            vscode.postMessage({ command: 'cancel' });
        }

        // Allow Ctrl+S to save
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                save();
            }
        });
    </script>
</body>
</html>`;
    }

    private escHtml(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
}
