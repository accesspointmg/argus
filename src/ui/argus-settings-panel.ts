// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Argus Settings webview — one panel for all global Argus configuration.
 *
 * The page (`media/webview/argus-settings.js`) is static and CSP-locked. On
 * `ready` it receives the field list — labels from {@link resolveFields},
 * types/defaults/enums from package.json, values from the user's global
 * settings — and renders it with DOM APIs. Every message it sends back is
 * validated here before anything is written; the webview is untrusted.
 *
 * Writes go to `ConfigurationTarget.Global` (Argus settings are
 * application-scoped). Secrets (API keys, SMTP password) go to SecretStorage.
 */

import * as vscode from 'vscode';
import type { ModelInfo, ProviderId } from '../llm/types';
import { KEYED_PROVIDERS } from '../llm/types';
import { apiKeyStorageKey, createProvider, providerNeedsKey, readAiSettings, type AiSettings } from '../llm/service';
import { promptAndStoreApiKey } from '../llm/setup';
import {
    TABS, isRecord, planSave, resolveFields, toView, validateValue,
    type ActionView, type FieldView, type InspectLike, type JsonSchemaProp, type ResolvedField,
} from './settings-model';
import { errorText, panelOptions, renderShell } from './webview';

/** Command the extension registers to check `claude` CLI login. */
export const CHECK_CLAUDE_LOGIN_COMMAND = 'argus.checkClaudeLogin';

const SMTP_PASSWORD_KEY = 'argus.smtpPassword';
const LIST_MODELS_TIMEOUT_MS = 15_000;

type Item = FieldView | ActionView;

export class ArgusSettingsPanel {
    public static readonly viewType = 'argus.settings';
    private static instance: ArgusSettingsPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];
    private fields: ResolvedField[] = [];
    private saving = false;

    static show(extensionUri: vscode.Uri, secrets: vscode.SecretStorage): void {
        if (ArgusSettingsPanel.instance) {
            ArgusSettingsPanel.instance.panel.reveal();
            return;
        }
        ArgusSettingsPanel.instance = new ArgusSettingsPanel(extensionUri, secrets);
    }

    private constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly secrets: vscode.SecretStorage,
    ) {
        this.panel = vscode.window.createWebviewPanel(
            ArgusSettingsPanel.viewType,
            'Argus Settings',
            vscode.ViewColumn.One,
            panelOptions(extensionUri),
        );
        this.panel.iconPath = new vscode.ThemeIcon('settings-gear');
        this.panel.webview.html = renderShell(this.panel.webview, extensionUri, {
            title: 'Argus Settings',
            script: 'argus-settings.js',
        });

        this.panel.webview.onDidReceiveMessage((msg: unknown) => {
            this.onMessage(msg).catch((err) => {
                vscode.window.showErrorMessage(`Argus settings: ${errorText(err)}`);
            });
        }, undefined, this.disposables);

        this.disposables.push(vscode.workspace.onDidChangeConfiguration((e) => {
            if (!this.saving && e.affectsConfiguration('argus')) {
                this.post({ type: 'stale' });
            }
        }));

        this.panel.onDidDispose(() => {
            ArgusSettingsPanel.instance = undefined;
            for (const d of this.disposables) { d.dispose(); }
        });
    }

    // ─── Messages from the webview (untrusted) ──────────────────

    private async onMessage(msg: unknown): Promise<void> {
        if (!isRecord(msg) || typeof msg.type !== 'string') { return; }
        switch (msg.type) {
            case 'ready':
                await this.sendInit();
                return;
            case 'save':
                await this.handleSave(msg.values);
                return;
            case 'fetchModels':
                await this.handleFetchModels(msg.requestId, msg.provider, msg.baseUrl, msg.vendor);
                return;
            case 'setApiKey':
                await this.handleSetApiKey(msg.provider);
                return;
            case 'setSmtpPassword':
                await this.handleSetSmtpPassword();
                return;
            case 'checkClaudeLogin':
                await this.handleCheckClaudeLogin();
                return;
            case 'cancel':
                this.panel.dispose();
                return;
        }
    }

    private async sendInit(): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('argus');
        const inspect = (key: string): InspectLike | undefined => cfg.inspect(key);
        this.fields = resolveFields(readConfigSchema(this.extensionUri), inspect);
        const smtpSet = !!(await this.secrets.get(SMTP_PASSWORD_KEY));
        this.post({ type: 'init', tabs: TABS, items: this.buildItems(smtpSet) });
    }

    /** Field views with action buttons slotted in after the field they belong to. */
    private buildItems(smtpPasswordSet: boolean): Item[] {
        const providers = this.providerOptions();
        const keyed = KEYED_PROVIDERS.filter((p) => providers.includes(p));
        const after = new Map<string, ActionView[]>();
        const add = (fieldId: string, a: ActionView): void => {
            after.set(fieldId, [...(after.get(fieldId) ?? []), a]);
        };

        if (keyed.length) {
            add('ai.model', {
                id: 'action.apiKey', kind: 'action', action: 'setApiKey', tab: 'ai',
                label: 'Set API key', showFor: keyed, help: 'Stored in VS Code SecretStorage.',
            });
        }
        if (providers.includes('claude-code')) {
            add('ai.model', {
                id: 'action.claudeLogin', kind: 'action', action: 'checkClaudeLogin', tab: 'ai',
                label: 'Check Claude login', showFor: ['claude-code'],
                help: 'Model accepts an alias (opus, sonnet, haiku, fable) or a full model id. Sign in with `claude` in a terminal.',
            });
        }
        add('email.smtp/secure', {
            id: 'action.smtpPassword', kind: 'action', action: 'setSmtpPassword', tab: 'email', section: 'SMTP server',
            label: 'Set SMTP password', status: smtpPasswordSet ? '✓ Stored' : 'Not set',
            help: 'Stored in VS Code SecretStorage.',
        });

        const items: Item[] = [];
        for (const f of this.fields) {
            items.push(toView(f));
            items.push(...(after.get(f.id) ?? []));
            after.delete(f.id);
        }
        for (const rest of after.values()) { items.push(...rest); }
        return items;
    }

    private providerOptions(): string[] {
        return this.fields.find((f) => f.id === 'ai.provider')?.options?.map((o) => o.value) ?? [];
    }

    private async handleSave(values: unknown): Promise<void> {
        if (!this.fields.length) { return; }
        const cfg = vscode.workspace.getConfiguration('argus');
        const plan = planSave(values, this.fields, (key) => cfg.inspect(key));
        if (Object.keys(plan.errors).length) {
            this.post({ type: 'saved', ok: false, errors: plan.errors });
            return;
        }

        this.saving = true;
        try {
            for (const u of plan.updates) {
                await cfg.update(u.key, u.value, vscode.ConfigurationTarget.Global);
            }
        } catch (err) {
            this.post({ type: 'saved', ok: false, errors: { _form: errorText(err) } });
            return;
        } finally {
            this.saving = false;
        }

        this.post({ type: 'saved', ok: true, count: plan.updates.length });
        await this.sendInit();
        vscode.window.showInformationMessage(
            plan.updates.length ? 'Argus settings saved.' : 'Argus settings unchanged.',
        );
    }

    /** Validated provider id from the webview, or undefined. */
    private checkProvider(raw: unknown): ProviderId | undefined {
        return typeof raw === 'string' && this.providerOptions().includes(raw) ? (raw as ProviderId) : undefined;
    }

    private async handleFetchModels(rawId: unknown, rawProvider: unknown, rawBaseUrl: unknown, rawVendor: unknown): Promise<void> {
        const requestId = typeof rawId === 'number' && Number.isSafeInteger(rawId) ? rawId : 0;
        const provider = this.checkProvider(rawProvider);
        const baseUrlField = this.fields.find((f) => f.id === 'ai.baseUrl');
        const vendorField = this.fields.find((f) => f.id === 'ai.vendor');
        const baseUrlR = baseUrlField ? validateValue(baseUrlField, rawBaseUrl ?? '') : { value: '' };
        const vendorR = vendorField ? validateValue(vendorField, rawVendor ?? '') : { value: '' };
        const reply = (r: { models?: ModelInfo[]; detail?: string; keyStatus?: string }): void => {
            this.post({
                type: 'models',
                requestId,
                models: (r.models ?? []).slice(0, 500).map((m) => ({
                    id: String(m.id).slice(0, 200),
                    label: String(m.label || m.id).slice(0, 200),
                    detail: String(m.detail ?? '').slice(0, 200),
                })),
                detail: r.detail ?? '',
                keyStatus: r.keyStatus ?? 'not-needed',
            });
        };
        if (!provider || baseUrlR.error || vendorR.error) {
            reply({ detail: baseUrlR.error ?? vendorR.error ?? 'Unknown provider.' });
            return;
        }

        const saved = readAiSettings();
        const baseUrl = String(baseUrlR.value ?? '');
        const keyed = providerNeedsKey(provider);
        const storedKey = keyed ? (await this.secrets.get(apiKeyStorageKey(provider))) ?? '' : '';
        // Never send a stored key to an endpoint the user hasn't saved.
        const keyAllowed = baseUrl === '' || baseUrl === saved.baseUrl;
        const keyStatus = !keyed ? 'not-needed' : storedKey ? 'stored' : 'missing';

        const settings: AiSettings = {
            ...saved,
            provider,
            baseUrl,
            vendor: String(vendorR.value || saved.vendor),
            model: '',
        };

        let models: ModelInfo[] = [];
        let detail = '';
        try {
            const built = createProvider(settings, keyAllowed ? storedKey : '');
            if (!built?.listModels) { throw new Error('This provider can’t list models.'); }
            models = await withTimeout(built.listModels(), LIST_MODELS_TIMEOUT_MS);
        } catch (err) {
            detail = errorText(err);
            if (keyed && storedKey && !keyAllowed) {
                detail = 'Save the new base URL first — your stored key is only sent to the saved endpoint.';
            }
        }

        reply({ models, detail, keyStatus });
    }

    private async handleSetApiKey(rawProvider: unknown): Promise<void> {
        const provider = this.checkProvider(rawProvider);
        if (!provider || !providerNeedsKey(provider)) { return; }
        const key = await promptAndStoreApiKey(this.secrets, provider);
        if (key !== undefined) {
            this.post({ type: 'apiKeySet', provider });
        }
    }

    private async handleSetSmtpPassword(): Promise<void> {
        const password = await vscode.window.showInputBox({
            title: 'Set SMTP Password',
            prompt: 'SMTP password (or app password) for Argus email notifications',
            password: true,
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim() ? undefined : 'Password cannot be empty'),
        });
        if (!password) { return; }
        await this.secrets.store(SMTP_PASSWORD_KEY, password.trim());
        vscode.window.showInformationMessage('SMTP password saved.');
        this.post({ type: 'actionStatus', id: 'action.smtpPassword', status: '✓ Stored' });
    }

    /**
     * Runs {@link CHECK_CLAUDE_LOGIN_COMMAND}. Accepted results: `boolean`,
     * `{ ok | loggedIn: boolean; detail | message?: string }`, or undefined.
     */
    private async handleCheckClaudeLogin(): Promise<void> {
        this.post({ type: 'actionStatus', id: 'action.claudeLogin', status: 'Checking…' });
        let status: string;
        try {
            const r: unknown = await vscode.commands.executeCommand(CHECK_CLAUDE_LOGIN_COMMAND);
            let ok: boolean | undefined;
            let detail = '';
            if (typeof r === 'boolean') {
                ok = r;
            } else if (isRecord(r)) {
                ok = typeof r.ok === 'boolean' ? r.ok : typeof r.loggedIn === 'boolean' ? r.loggedIn : undefined;
                detail = typeof r.detail === 'string' ? r.detail : typeof r.message === 'string' ? r.message : '';
            }
            const head = ok === true ? '✓ Signed in' : ok === false ? '✗ Not signed in' : 'Check finished';
            status = detail ? `${head} — ${detail}` : head;
        } catch (err) {
            status = `Could not check: ${errorText(err)}`;
        }
        this.post({ type: 'actionStatus', id: 'action.claudeLogin', status: status.slice(0, 300) });
    }

    private post(msg: Record<string, unknown>): void {
        void this.panel.webview.postMessage(msg);
    }
}

/** `contributes.configuration` properties from this extension's package.json. */
function readConfigSchema(extensionUri: vscode.Uri): Record<string, JsonSchemaProp> {
    const self = extensionUri.toString();
    const ext = vscode.extensions.all.find((e) => e.extensionUri.toString() === self);
    const pkg: unknown = ext?.packageJSON;
    const contributes = isRecord(pkg) && isRecord(pkg.contributes) ? pkg.contributes : undefined;
    const conf = contributes?.configuration;
    const sections = Array.isArray(conf) ? conf : conf ? [conf] : [];
    const out: Record<string, JsonSchemaProp> = {};
    for (const s of sections) {
        if (isRecord(s) && isRecord(s.properties)) {
            for (const [k, v] of Object.entries(s.properties)) {
                if (isRecord(v)) { out[k] = v as JsonSchemaProp; }
            }
        }
    }
    return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Timed out listing models.')), ms);
        p.then(
            (v) => { clearTimeout(t); resolve(v); },
            (e) => { clearTimeout(t); reject(e); },
        );
    });
}
