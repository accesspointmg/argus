// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Repo Settings webview — per-repository email recipients and SMTP override.
 *
 * Same model as the global panel: static CSP-locked page
 * (`media/webview/repo-settings.js`), data by `postMessage`, and every
 * message validated here before the `argus.repos` entry is rewritten.
 */

import * as vscode from 'vscode';
import type { RepoConfig } from '../forge/types';
import { formatRepoString, parseRepoEntry } from '../util/config';
import { checks, isRecord } from './settings-model';
import { errorText, panelOptions, renderShell } from './webview';

/** Raw `argus.repos` entry: a repo string or an object with overrides. */
export type RawRepoEntry = string | Record<string, unknown>;

const MAX_RECIPIENTS = 100;

interface RepoEmailForm {
    recipients: string[];
    smtpHost: string;
    smtpPort: number | null;
    smtpSecure: boolean;
    smtpUser: string;
}

export class RepoSettingsPanel {
    public static readonly viewType = 'argus.repoSettings';
    private static panels = new Map<string, RepoSettingsPanel>();

    private readonly panel: vscode.WebviewPanel;
    private readonly repoKey: string;
    private readonly disposables: vscode.Disposable[] = [];

    /**
     * Show (or re-focus) the settings panel for a repo.
     *
     * `allRepos` is only a fallback: on save the current `argus.repos` global
     * value is re-read so concurrent edits aren't clobbered.
     */
    static show(
        extensionUri: vscode.Uri,
        repo: RepoConfig,
        allRepos: readonly unknown[],
        onSave: (updated: unknown[]) => Promise<void>,
    ): void {
        const key = formatRepoString(repo);
        const existing = RepoSettingsPanel.panels.get(key);
        if (existing) {
            existing.panel.reveal();
            return;
        }
        RepoSettingsPanel.panels.set(key, new RepoSettingsPanel(extensionUri, repo, allRepos, onSave));
    }

    private constructor(
        extensionUri: vscode.Uri,
        private repo: RepoConfig,
        private readonly allRepos: readonly unknown[],
        private readonly onSave: (updated: unknown[]) => Promise<void>,
    ) {
        this.repoKey = formatRepoString(repo);
        this.panel = vscode.window.createWebviewPanel(
            RepoSettingsPanel.viewType,
            `Repo: ${repo.owner}/${repo.repo}`,
            vscode.ViewColumn.One,
            panelOptions(extensionUri),
        );
        this.panel.iconPath = new vscode.ThemeIcon('repo');
        this.panel.webview.html = renderShell(this.panel.webview, extensionUri, {
            title: 'Repository Settings',
            script: 'repo-settings.js',
        });

        this.panel.webview.onDidReceiveMessage((msg: unknown) => {
            this.onMessage(msg).catch((err) => {
                vscode.window.showErrorMessage(`Argus repo settings: ${errorText(err)}`);
            });
        }, undefined, this.disposables);

        this.panel.onDidDispose(() => {
            RepoSettingsPanel.panels.delete(this.repoKey);
            for (const d of this.disposables) { d.dispose(); }
        });
    }

    private async onMessage(msg: unknown): Promise<void> {
        if (!isRecord(msg) || typeof msg.type !== 'string') { return; }
        switch (msg.type) {
            case 'ready':
                this.sendInit();
                return;
            case 'save':
                await this.handleSave(msg.data);
                return;
            case 'cancel':
                this.panel.dispose();
                return;
        }
    }

    private sendInit(): void {
        const email = this.repo.email ?? {};
        void this.panel.webview.postMessage({
            type: 'init',
            title: `${this.repo.owner}/${this.repo.repo}`,
            forge: this.repo.forge,
            recipients: email.recipients ?? [],
            smtp: {
                host: email.smtp?.host ?? '',
                port: email.smtp?.port ?? null,
                secure: email.smtp?.secure ?? false,
                user: email.smtp?.user ?? '',
            },
        });
    }

    private async handleSave(raw: unknown): Promise<void> {
        const parsed = parseForm(raw);
        if ('errors' in parsed) {
            void this.panel.webview.postMessage({ type: 'saved', ok: false, errors: parsed.errors });
            return;
        }
        const form = parsed.form;

        const configured = vscode.workspace.getConfiguration('argus').inspect<unknown[]>('repos')?.globalValue;
        const current = Array.isArray(configured) ? configured : [...this.allRepos];
        let matched = false;
        const updated = current.map((entry) => {
            if (!this.matches(entry)) { return entry; }
            matched = true;
            return withEmail(entry as RawRepoEntry, form);
        });
        if (!matched) {
            void this.panel.webview.postMessage({
                type: 'saved', ok: false,
                errors: { _form: 'This repository is no longer in argus.repos.' },
            });
            return;
        }

        await this.onSave(updated);
        const fresh = updated.find((e) => this.matches(e));
        const reparsed = fresh !== undefined ? parseRepoEntry(fresh as RawRepoEntry, this.repo.pollIntervalMinutes) : null;
        if (reparsed) { this.repo = { ...this.repo, email: reparsed.email }; }
        void this.panel.webview.postMessage({ type: 'saved', ok: true });
        this.sendInit();
        vscode.window.showInformationMessage(`Settings saved for ${this.repo.owner}/${this.repo.repo}.`);
    }

    private matches(entry: unknown): boolean {
        if (typeof entry !== 'string' && !isRecord(entry)) { return false; }
        const p = parseRepoEntry(entry);
        return !!p && formatRepoString(p) === this.repoKey;
    }
}

/** Validate the untrusted form payload. */
function parseForm(raw: unknown): { form: RepoEmailForm } | { errors: Record<string, string> } {
    if (!isRecord(raw)) { return { errors: { _form: 'Malformed save request.' } }; }
    const errors: Record<string, string> = {};
    const str = (k: string, max: number, check: (v: string) => string | undefined): string => {
        const v = raw[k];
        if (typeof v !== 'string') { errors[k] = 'Expected text.'; return ''; }
        const t = v.trim();
        if (t.length > max) { errors[k] = `At most ${max} characters.`; return ''; }
        const e = check(t);
        if (e) { errors[k] = e; }
        return t;
    };

    const recipients: string[] = [];
    if (!Array.isArray(raw.recipients) || raw.recipients.length > MAX_RECIPIENTS) {
        errors.recipients = `Expected up to ${MAX_RECIPIENTS} addresses.`;
    } else {
        for (const r of raw.recipients) {
            const t = typeof r === 'string' ? r.trim() : '';
            if (!t) { continue; }
            const e = t.length > 320 ? 'Address too long.' : checks.email(t);
            if (e) { errors.recipients = `${t.slice(0, 60)}: ${e}`; break; }
            if (!recipients.includes(t)) { recipients.push(t); }
        }
    }

    const smtpHost = str('smtpHost', 253, checks.host);
    const smtpUser = str('smtpUser', 320, checks.noControl);
    let smtpPort: number | null = null;
    if (raw.smtpPort !== null) {
        if (typeof raw.smtpPort !== 'number' || !Number.isInteger(raw.smtpPort) || raw.smtpPort < 1 || raw.smtpPort > 65535) {
            errors.smtpPort = 'Port must be a whole number from 1 to 65535.';
        } else {
            smtpPort = raw.smtpPort;
        }
    }
    if (typeof raw.smtpSecure !== 'boolean') { errors.smtpSecure = 'Expected true/false.'; }

    if (Object.keys(errors).length) { return { errors }; }
    return { form: { recipients, smtpHost, smtpPort, smtpSecure: raw.smtpSecure === true, smtpUser } };
}

/**
 * Return `entry` with its email overrides replaced by `form`, keeping the
 * original repo string (so a self-hosted URL isn't canonicalized away) and
 * any other keys. Collapses back to a plain string when nothing else is set.
 */
function withEmail(entry: RawRepoEntry, form: RepoEmailForm): RawRepoEntry {
    const base: Record<string, unknown> = typeof entry === 'string' ? { repo: entry } : { ...entry };
    const email: Record<string, unknown> = isRecord(base.email) ? { ...base.email } : {};
    delete email.recipients;
    delete email.smtp;

    if (form.recipients.length) { email.recipients = form.recipients; }
    const smtp: Record<string, unknown> = {};
    if (form.smtpHost) { smtp.host = form.smtpHost; }
    if (form.smtpPort !== null) { smtp.port = form.smtpPort; }
    if (form.smtpUser) { smtp.user = form.smtpUser; }
    if (Object.keys(smtp).length || form.smtpSecure) { smtp.secure = form.smtpSecure; }
    if (Object.keys(smtp).length) { email.smtp = smtp; }

    if (Object.keys(email).length) { base.email = email; } else { delete base.email; }
    const keys = Object.keys(base);
    if (keys.length === 1 && keys[0] === 'repo' && typeof base.repo === 'string') { return base.repo; }
    return base;
}
