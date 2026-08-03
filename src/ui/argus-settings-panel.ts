// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Argus Settings webview — a single panel for all global Argus configuration:
 * AI provider, email/SMTP, security, rate limits, labels, etc.
 *
 * Settings are read from VS Code config on open and written back on save.
 * The SMTP password is stored in SecretStorage, not in config.
 */

import * as vscode from 'vscode';
import type { ProviderId, ModelInfo } from '../llm/types';
import { providerNeedsKey, apiKeyStorageKey, createProvider, readAiSettings } from '../llm/service';
import { promptAndStoreApiKey } from '../llm/setup';

interface SettingsData {
    // AI
    aiProvider: string;
    aiModel: string;
    aiEffort: string;
    aiBaseUrl: string;
    aiVendor: string;
    aiMaxTokens: number;
    // Email
    emailEnabled: boolean;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUser: string;
    emailFromAddress: string;
    emailFromName: string;
    defaultRecipients: string;
    // Pipeline
    branchPrefix: string;
    maxIterations: number;
    maxDiffLines: number;
    maxConcurrentIssues: number;
    dryRun: boolean;
    autoStart: boolean;
    watchdogTimeout: number;
    // Labels
    labelApproved: string;
    labelRejected: string;
    labelNeedsReview: string;
    labelSubversion: string;
    // Security
    threatThreshold: number;
    blockThreshold: number;
    reportOnBlock: boolean;
    deleteHostile: boolean;
    reEvalOnEdit: boolean;
    maxInputLength: number;
    // Rate limits
    rlComments: number;
    rlBranches: number;
    rlPrs: number;
    rlPushes: number;
    rlBlocks: number;
    rlLlm: number;
    rlIssues: number;
    rlQueueDepth: number;
}

export class ArgusSettingsPanel {
    public static readonly viewType = 'argus.settings';
    private static instance: ArgusSettingsPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];

    static show(
        extensionUri: vscode.Uri,
        secrets: vscode.SecretStorage,
    ): void {
        if (ArgusSettingsPanel.instance) {
            ArgusSettingsPanel.instance.panel.reveal();
            return;
        }
        new ArgusSettingsPanel(extensionUri, secrets);
    }

    private constructor(
        extensionUri: vscode.Uri,
        private readonly secrets: vscode.SecretStorage,
    ) {
        this.panel = vscode.window.createWebviewPanel(
            ArgusSettingsPanel.viewType,
            'Argus Settings',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
            },
        );

        ArgusSettingsPanel.instance = this;
        this.panel.iconPath = new vscode.ThemeIcon('settings-gear');
        this.panel.webview.html = this.getHtml();

        this.panel.webview.onDidReceiveMessage(
            async (msg) => {
                switch (msg.command) {
                    case 'save':
                        await this.handleSave(msg.data);
                        break;
                    case 'setSmtpPassword':
                        await this.handleSetSmtpPassword();
                        break;
                    case 'fetchModels':
                        await this.handleFetchModels(msg.provider, msg.baseUrl);
                        break;
                    case 'setApiKey':
                        await this.handleSetApiKey(msg.provider, msg.baseUrl);
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
            ArgusSettingsPanel.instance = undefined;
            for (const d of this.disposables) { d.dispose(); }
        });
    }

    private async handleSave(data: SettingsData): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('argus');
        const target = vscode.ConfigurationTarget.Global;

        // AI
        await cfg.update('ai.provider', data.aiProvider, target);
        await cfg.update('ai.model', data.aiModel, target);
        await cfg.update('ai.effort', data.aiEffort, target);
        await cfg.update('ai.baseUrl', data.aiBaseUrl || undefined, target);
        await cfg.update('ai.vendor', data.aiVendor, target);
        await cfg.update('ai.maxTokens', data.aiMaxTokens, target);

        // Email
        await cfg.update('email.enabled', data.emailEnabled, target);
        await cfg.update('email.smtp', {
            host: data.smtpHost,
            port: data.smtpPort,
            secure: data.smtpSecure,
            user: data.smtpUser,
        }, target);
        await cfg.update('email.fromAddress', data.emailFromAddress, target);
        await cfg.update('email.fromName', data.emailFromName, target);
        const recipients = data.defaultRecipients
            ? data.defaultRecipients.split(',').map((s: string) => s.trim()).filter(Boolean)
            : [];
        await cfg.update('email.defaultRecipients', recipients, target);

        // Pipeline
        await cfg.update('branchPrefix', data.branchPrefix, target);
        await cfg.update('maxIterations', data.maxIterations, target);
        await cfg.update('maxDiffLines', data.maxDiffLines, target);
        await cfg.update('maxConcurrentIssues', data.maxConcurrentIssues, target);
        await cfg.update('dryRun', data.dryRun, target);
        await cfg.update('autoStartOnActivation', data.autoStart, target);
        await cfg.update('watchdogTimeoutMinutes', data.watchdogTimeout, target);

        // Labels
        await cfg.update('labels.approved', data.labelApproved, target);
        await cfg.update('labels.rejected', data.labelRejected, target);
        await cfg.update('labels.needsReview', data.labelNeedsReview, target);
        await cfg.update('labels.subversionDetected', data.labelSubversion, target);

        // Security
        await cfg.update('security.threatThreshold', data.threatThreshold, target);
        await cfg.update('security.blockThreshold', data.blockThreshold, target);
        await cfg.update('security.reportOnBlock', data.reportOnBlock, target);
        await cfg.update('security.deleteHostileComments', data.deleteHostile, target);
        await cfg.update('security.reEvaluateOnEdit', data.reEvalOnEdit, target);
        await cfg.update('security.maxInputLength', data.maxInputLength, target);

        // Rate limits
        await cfg.update('rateLimits.commentsPerHour', data.rlComments, target);
        await cfg.update('rateLimits.branchesPerHour', data.rlBranches, target);
        await cfg.update('rateLimits.prsPerHour', data.rlPrs, target);
        await cfg.update('rateLimits.pushesPerHour', data.rlPushes, target);
        await cfg.update('rateLimits.blocksPerDay', data.rlBlocks, target);
        await cfg.update('rateLimits.llmCallsPerHour', data.rlLlm, target);
        await cfg.update('rateLimits.issuesPerHour', data.rlIssues, target);
        await cfg.update('rateLimits.queueDepth', data.rlQueueDepth, target);

        vscode.window.showInformationMessage('Argus settings saved. Restart Argus to apply changes.');
    }

    private async handleSetApiKey(providerId: string, baseUrl: string): Promise<void> {
        const provider = providerId as ProviderId;
        const key = await promptAndStoreApiKey(this.secrets, provider);
        if (key !== undefined) {
            // Key was stored — re-fetch models now
            await this.handleFetchModels(providerId, baseUrl);
        }
    }

    /** Well-known models for providers, used when live discovery fails or no key is stored. */
    private static readonly FALLBACK_MODELS: Partial<Record<ProviderId, ModelInfo[]>> = {
        anthropic: [
            { id: 'claude-opus-5', label: 'Claude Opus 5', detail: '200K context' },
            { id: 'claude-opus-4-0', label: 'Claude Opus 4', detail: '200K context' },
            { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', detail: '200K context' },
            { id: 'claude-haiku-4-20250414', label: 'Claude Haiku 4', detail: '200K context' },
        ],
        openai: [
            { id: 'o3', label: 'o3' },
            { id: 'o3-mini', label: 'o3-mini' },
            { id: 'o3-pro', label: 'o3-pro' },
            { id: 'o4-mini', label: 'o4-mini' },
            { id: 'gpt-4.1', label: 'GPT-4.1' },
            { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
            { id: 'gpt-4.1-nano', label: 'GPT-4.1 Nano' },
            { id: 'gpt-4o', label: 'GPT-4o' },
            { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
        ],
        gemini: [
            { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', detail: '1M context' },
            { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', detail: '1M context' },
            { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', detail: '1M context' },
            { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite', detail: '1M context' },
        ],
    };

    private async handleFetchModels(providerId: string, baseUrl: string): Promise<void> {
        const provider = providerId as ProviderId;
        let apiKey = '';
        if (providerNeedsKey(provider)) {
            apiKey = (await this.secrets.get(apiKeyStorageKey(provider))) ?? '';
        }

        const settings = {
            ...readAiSettings(),
            provider,
            baseUrl: baseUrl || readAiSettings().baseUrl,
            model: '',
        };

        // Try live discovery first
        let models: ModelInfo[] = [];
        let failReason = '';
        try {
            const built = createProvider(settings, apiKey);
            models = (await built.listModels?.()) ?? [];
        } catch (err) {
            failReason = String(err instanceof Error ? err.message : err);
        }

        // Fall back to static list for known providers
        const usedFallback = models.length === 0 && ArgusSettingsPanel.FALLBACK_MODELS[provider];
        if (usedFallback) {
            models = ArgusSettingsPanel.FALLBACK_MODELS[provider]!;
        }

        this.panel.webview.postMessage({
            command: 'modelsLoaded',
            models: models.map((m) => ({ id: m.id, label: m.label, detail: m.detail ?? '' })),
            reason: models.length > 0 ? 'ok' : 'fetch-failed',
            detail: failReason,
            fallback: !!usedFallback,
        });
    }

    private async handleSetSmtpPassword(): Promise<void> {
        const password = await vscode.window.showInputBox({
            title: 'Set SMTP Password',
            prompt: 'Enter the SMTP password (or app password) for Argus email notifications',
            password: true,
            placeHolder: 'SMTP password',
            validateInput: (v) => v.trim() ? undefined : 'Password cannot be empty',
        });
        if (!password) { return; }
        await this.secrets.store('argus.smtpPassword', password.trim());
        vscode.window.showInformationMessage('SMTP password saved.');
        this.panel.webview.postMessage({ command: 'smtpPasswordSet' });
    }

    private readSettings(): SettingsData {
        const cfg = vscode.workspace.getConfiguration('argus');
        const smtp: Record<string, any> = cfg.get('email.smtp', {});

        return {
            aiProvider: cfg.get('ai.provider', 'vscode-lm'),
            aiModel: cfg.get('ai.model', ''),
            aiEffort: cfg.get('ai.effort', 'default'),
            aiBaseUrl: cfg.get('ai.baseUrl', ''),
            aiVendor: cfg.get('ai.vendor', 'copilot'),
            aiMaxTokens: cfg.get('ai.maxTokens', 32000),
            emailEnabled: cfg.get('email.enabled', false),
            smtpHost: smtp.host ?? '',
            smtpPort: smtp.port ?? 587,
            smtpSecure: smtp.secure ?? false,
            smtpUser: smtp.user ?? '',
            emailFromAddress: cfg.get('email.fromAddress', ''),
            emailFromName: cfg.get('email.fromName', 'Argus'),
            defaultRecipients: (cfg.get<string[]>('email.defaultRecipients', []) ?? []).join(', '),
            branchPrefix: cfg.get('branchPrefix', 'ai-fix/'),
            maxIterations: cfg.get('maxIterations', 5),
            maxDiffLines: cfg.get('maxDiffLines', 500),
            maxConcurrentIssues: cfg.get('maxConcurrentIssues', 1),
            dryRun: cfg.get('dryRun', false),
            autoStart: cfg.get('autoStartOnActivation', false),
            watchdogTimeout: cfg.get('watchdogTimeoutMinutes', 30),
            labelApproved: cfg.get('labels.approved', 'ai-triaged'),
            labelRejected: cfg.get('labels.rejected', 'ai-rejected'),
            labelNeedsReview: cfg.get('labels.needsReview', 'needs-human-review'),
            labelSubversion: cfg.get('labels.subversionDetected', 'subversion-detected'),
            threatThreshold: cfg.get('security.threatThreshold', 0.5),
            blockThreshold: cfg.get('security.blockThreshold', 0.8),
            reportOnBlock: cfg.get('security.reportOnBlock', false),
            deleteHostile: cfg.get('security.deleteHostileComments', true),
            reEvalOnEdit: cfg.get('security.reEvaluateOnEdit', true),
            maxInputLength: cfg.get('security.maxInputLength', 4000),
            rlComments: cfg.get('rateLimits.commentsPerHour', 30),
            rlBranches: cfg.get('rateLimits.branchesPerHour', 10),
            rlPrs: cfg.get('rateLimits.prsPerHour', 5),
            rlPushes: cfg.get('rateLimits.pushesPerHour', 20),
            rlBlocks: cfg.get('rateLimits.blocksPerDay', 3),
            rlLlm: cfg.get('rateLimits.llmCallsPerHour', 100),
            rlIssues: cfg.get('rateLimits.issuesPerHour', 10),
            rlQueueDepth: cfg.get('rateLimits.queueDepth', 50),
        };
    }

    private getHtml(): string {
        const s = this.readSettings();

        const providerOptions = [
            ['vscode-lm', 'VS Code / Copilot'],
            ['anthropic', 'Anthropic Claude'],
            ['openai', 'OpenAI'],
            ['gemini', 'Google Gemini'],
            ['ollama', 'Ollama (local)'],
            ['openai-compatible', 'OpenAI-Compatible'],
        ].map(([v, l]) => `<option value="${v}" ${s.aiProvider === v ? 'selected' : ''}>${l}</option>`).join('');

        const effortOptions = ['default', 'low', 'medium', 'high', 'xhigh', 'max']
            .map((v) => `<option value="${v}" ${s.aiEffort === v ? 'selected' : ''}>${v}</option>`).join('');

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
            max-width: 720px;
        }
        h1 {
            font-size: 1.5em;
            font-weight: 600;
            margin: 0 0 24px 0;
        }
        .tabs {
            display: flex;
            gap: 0;
            border-bottom: 1px solid var(--vscode-widget-border);
            margin-bottom: 20px;
        }
        .tab {
            padding: 8px 16px;
            cursor: pointer;
            border: none;
            background: none;
            color: var(--vscode-descriptionForeground);
            font-family: inherit;
            font-size: inherit;
            font-weight: 500;
            border-bottom: 2px solid transparent;
            transition: color 0.15s, border-color 0.15s;
        }
        .tab:hover {
            color: var(--vscode-foreground);
        }
        .tab.active {
            color: var(--vscode-foreground);
            border-bottom-color: var(--vscode-focusBorder);
        }
        .tab-content {
            display: none;
        }
        .tab-content.active {
            display: block;
        }
        .section {
            margin-bottom: 20px;
        }
        .section-title {
            font-size: 1.05em;
            font-weight: 600;
            margin-bottom: 10px;
            padding-bottom: 4px;
            border-bottom: 1px solid var(--vscode-widget-border);
        }
        label {
            display: block;
            font-weight: 500;
            margin-bottom: 4px;
            margin-top: 12px;
        }
        .help {
            color: var(--vscode-descriptionForeground);
            font-size: 0.85em;
            margin: 2px 0 0 0;
        }
        input[type="text"],
        input[type="number"],
        select {
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
        select {
            appearance: auto;
        }
        input:focus, select:focus {
            outline: 1px solid var(--vscode-focusBorder);
            border-color: var(--vscode-focusBorder);
        }
        .checkbox-row {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 12px;
        }
        .checkbox-row label { margin: 0; }
        .row-2col {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
        }
        .row-3col {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 12px;
        }
        .row-4col {
            display: grid;
            grid-template-columns: 1fr 1fr 1fr 1fr;
            gap: 12px;
        }
        .btn-row {
            display: flex;
            gap: 8px;
            margin-top: 28px;
            padding-top: 16px;
            border-top: 1px solid var(--vscode-widget-border);
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
        .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
        .btn-secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
        .btn-inline {
            padding: 4px 12px;
            font-size: 0.9em;
            margin-top: 8px;
        }
        #smtpPasswordStatus {
            display: inline-block;
            margin-left: 8px;
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <h1>⚙️ Argus Settings</h1>

    <div class="tabs">
        <button class="tab active" data-tab="ai">AI Provider</button>
        <button class="tab" data-tab="email">Email</button>
        <button class="tab" data-tab="pipeline">Pipeline</button>
        <button class="tab" data-tab="labels">Labels</button>
        <button class="tab" data-tab="security">Security</button>
        <button class="tab" data-tab="ratelimits">Rate Limits</button>
    </div>

    <!-- AI Provider -->
    <div id="tab-ai" class="tab-content active">
        <label for="aiProvider">Provider</label>
        <select id="aiProvider">${providerOptions}</select>

        <div style="margin-top:12px">
            <label for="aiModel">Model</label>
            <div id="modelSelectWrap" style="display:none">
                <select id="aiModelSelect" style="width:100%"></select>
                <p class="help"><a href="#" id="modelManualLink" style="color:var(--vscode-textLink-foreground)">Enter manually instead</a></p>
            </div>
            <div id="modelInputWrap">
                <input type="text" id="aiModel" value="${this.esc(s.aiModel)}" placeholder="Leave blank for provider default" />
                <p class="help" id="modelInputHelp">e.g. claude-opus-5, gpt-4o, gemini-2.0-flash, llama3.1</p>
            </div>
            <div id="modelLoading" style="display:none">
                <p class="help">Fetching models...</p>
            </div>
            <div id="modelNoKey" style="display:none; margin-top:8px">
                <button class="btn-secondary btn-inline" onclick="setApiKey()">Set API Key</button>
                <span id="modelNoKeyHelp" class="help" style="margin-left:8px"></span>
            </div>
        </div>

        <div id="field-effort" style="margin-top:12px">
            <label for="aiEffort">Effort</label>
            <select id="aiEffort">${effortOptions}</select>
            <p class="help">How hard the model thinks before answering. Higher = better + slower + costlier.</p>
        </div>

        <div id="field-baseUrl" style="margin-top:12px">
            <label for="aiBaseUrl">Base URL</label>
            <input type="text" id="aiBaseUrl" value="${this.esc(s.aiBaseUrl)}" placeholder="http://localhost:11434" />
        </div>

        <div id="field-vendor" style="margin-top:12px">
            <label for="aiVendor">VS Code LM Vendor</label>
            <input type="text" id="aiVendor" value="${this.esc(s.aiVendor)}" placeholder="copilot" />
            <p class="help">Which extension provides the model. Usually "copilot".</p>
        </div>

        <div id="field-maxTokens" style="margin-top:12px">
            <label for="aiMaxTokens">Max Tokens</label>
            <input type="number" id="aiMaxTokens" value="${s.aiMaxTokens}" min="1024" />
            <p class="help">Reply ceiling. Needs headroom — code generation returns whole files.</p>
        </div>
    </div>

    <!-- Email -->
    <div id="tab-email" class="tab-content">
        <div class="checkbox-row">
            <input type="checkbox" id="emailEnabled" ${s.emailEnabled ? 'checked' : ''} />
            <label for="emailEnabled">Enable email notifications</label>
        </div>

        <div class="section" style="margin-top:16px">
            <div class="section-title">SMTP Server</div>
            <div class="row-2col">
                <div>
                    <label for="smtpHost">Host</label>
                    <input type="text" id="smtpHost" value="${this.esc(s.smtpHost)}" placeholder="smtp.gmail.com" />
                </div>
                <div>
                    <label for="smtpPort">Port</label>
                    <input type="number" id="smtpPort" value="${s.smtpPort}" />
                </div>
            </div>
            <label for="smtpUser">User</label>
            <input type="text" id="smtpUser" value="${this.esc(s.smtpUser)}" placeholder="you@gmail.com" />
            <div class="checkbox-row">
                <input type="checkbox" id="smtpSecure" ${s.smtpSecure ? 'checked' : ''} />
                <label for="smtpSecure">Use SSL (port 465)</label>
            </div>
            <div style="margin-top:12px">
                <button class="btn-secondary btn-inline" onclick="setSmtpPassword()">Set SMTP Password</button>
                <span id="smtpPasswordStatus"></span>
            </div>
            <p class="help">Password is stored securely in VS Code's SecretStorage.</p>
        </div>

        <div class="section">
            <div class="section-title">Sender &amp; Recipients</div>
            <div class="row-2col">
                <div>
                    <label for="emailFromAddress">From Address</label>
                    <input type="text" id="emailFromAddress" value="${this.esc(s.emailFromAddress)}" placeholder="argus@example.com" />
                </div>
                <div>
                    <label for="emailFromName">From Name</label>
                    <input type="text" id="emailFromName" value="${this.esc(s.emailFromName)}" placeholder="Argus" />
                </div>
            </div>
            <label for="defaultRecipients">Default Recipients</label>
            <input type="text" id="defaultRecipients" value="${this.esc(s.defaultRecipients)}" placeholder="you@example.com, team@example.com" />
            <p class="help">Comma-separated. Used when a repo has no per-repo recipients configured.</p>
        </div>
    </div>

    <!-- Pipeline -->
    <div id="tab-pipeline" class="tab-content">
        <label for="branchPrefix">Branch Prefix</label>
        <input type="text" id="branchPrefix" value="${this.esc(s.branchPrefix)}" />

        <div class="row-3col">
            <div>
                <label for="maxIterations">Max Iterations</label>
                <input type="number" id="maxIterations" value="${s.maxIterations}" min="1" />
            </div>
            <div>
                <label for="maxDiffLines">Max Diff Lines</label>
                <input type="number" id="maxDiffLines" value="${s.maxDiffLines}" min="10" />
            </div>
            <div>
                <label for="maxConcurrentIssues">Concurrent Issues</label>
                <input type="number" id="maxConcurrentIssues" value="${s.maxConcurrentIssues}" min="1" />
            </div>
        </div>

        <label for="watchdogTimeout">Watchdog Timeout (min)</label>
        <input type="number" id="watchdogTimeout" value="${s.watchdogTimeout}" min="1" />
        <p class="help">Max minutes per issue before the watchdog aborts it.</p>

        <div class="checkbox-row">
            <input type="checkbox" id="dryRun" ${s.dryRun ? 'checked' : ''} />
            <label for="dryRun">Dry run (log actions without executing)</label>
        </div>
        <div class="checkbox-row">
            <input type="checkbox" id="autoStart" ${s.autoStart ? 'checked' : ''} />
            <label for="autoStart">Auto-start on VS Code launch</label>
        </div>
    </div>

    <!-- Labels -->
    <div id="tab-labels" class="tab-content">
        <p class="help" style="margin-bottom:12px">Labels Argus applies to issues it processes.</p>
        <div class="row-2col">
            <div>
                <label for="labelApproved">Approved</label>
                <input type="text" id="labelApproved" value="${this.esc(s.labelApproved)}" />
            </div>
            <div>
                <label for="labelRejected">Rejected</label>
                <input type="text" id="labelRejected" value="${this.esc(s.labelRejected)}" />
            </div>
        </div>
        <div class="row-2col">
            <div>
                <label for="labelNeedsReview">Needs Review</label>
                <input type="text" id="labelNeedsReview" value="${this.esc(s.labelNeedsReview)}" />
            </div>
            <div>
                <label for="labelSubversion">Subversion Detected</label>
                <input type="text" id="labelSubversion" value="${this.esc(s.labelSubversion)}" />
            </div>
        </div>
    </div>

    <!-- Security -->
    <div id="tab-security" class="tab-content">
        <div class="row-2col">
            <div>
                <label for="threatThreshold">Threat Threshold</label>
                <input type="number" id="threatThreshold" value="${s.threatThreshold}" min="0" max="1" step="0.05" />
                <p class="help">Min confidence to flag (0–1).</p>
            </div>
            <div>
                <label for="blockThreshold">Block Threshold</label>
                <input type="number" id="blockThreshold" value="${s.blockThreshold}" min="0" max="1" step="0.05" />
                <p class="help">Min confidence to block a user.</p>
            </div>
        </div>

        <label for="maxInputLength">Max Untrusted Input Length</label>
        <input type="number" id="maxInputLength" value="${s.maxInputLength}" min="100" />
        <p class="help">Max chars of untrusted text sent to LLM.</p>

        <div class="checkbox-row">
            <input type="checkbox" id="reportOnBlock" ${s.reportOnBlock ? 'checked' : ''} />
            <label for="reportOnBlock">Report user to platform when blocking</label>
        </div>
        <div class="checkbox-row">
            <input type="checkbox" id="deleteHostile" ${s.deleteHostile ? 'checked' : ''} />
            <label for="deleteHostile">Delete hostile comments</label>
        </div>
        <div class="checkbox-row">
            <input type="checkbox" id="reEvalOnEdit" ${s.reEvalOnEdit ? 'checked' : ''} />
            <label for="reEvalOnEdit">Re-evaluate issues on body edit</label>
        </div>
    </div>

    <!-- Rate Limits -->
    <div id="tab-ratelimits" class="tab-content">
        <p class="help" style="margin-bottom:12px">Guard rails to prevent runaway automation.</p>
        <div class="row-2col">
            <div>
                <label for="rlComments">Comments / hr</label>
                <input type="number" id="rlComments" value="${s.rlComments}" min="1" />
            </div>
            <div>
                <label for="rlBranches">Branches / hr</label>
                <input type="number" id="rlBranches" value="${s.rlBranches}" min="1" />
            </div>
        </div>
        <div class="row-2col">
            <div>
                <label for="rlPrs">PRs / hr</label>
                <input type="number" id="rlPrs" value="${s.rlPrs}" min="1" />
            </div>
            <div>
                <label for="rlPushes">Pushes / hr</label>
                <input type="number" id="rlPushes" value="${s.rlPushes}" min="1" />
            </div>
        </div>
        <div class="row-2col">
            <div>
                <label for="rlLlm">LLM Calls / hr</label>
                <input type="number" id="rlLlm" value="${s.rlLlm}" min="1" />
            </div>
            <div>
                <label for="rlIssues">Issues / hr</label>
                <input type="number" id="rlIssues" value="${s.rlIssues}" min="1" />
            </div>
        </div>
        <div class="row-2col">
            <div>
                <label for="rlBlocks">Blocks / day</label>
                <input type="number" id="rlBlocks" value="${s.rlBlocks}" min="0" />
            </div>
            <div>
                <label for="rlQueueDepth">Queue Depth</label>
                <input type="number" id="rlQueueDepth" value="${s.rlQueueDepth}" min="1" />
            </div>
        </div>
    </div>

    <div class="btn-row">
        <button class="btn-primary" onclick="save()">Save All Settings</button>
        <button class="btn-secondary" onclick="cancel()">Cancel</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        let useManualModel = false;
        const currentModel = '${this.esc(s.aiModel)}';

        // Tab switching
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
            });
        });

        // Provider change → update visible fields + clear stale model + fetch models
        document.getElementById('aiProvider').addEventListener('change', () => {
            updateProviderFields();
            // Clear the model field — the old provider's model name is meaningless here
            document.getElementById('aiModel').value = '';
            fetchModels();
        });

        /** Show/hide fields based on the selected provider. */
        function updateProviderFields() {
            const p = val('aiProvider');
            const show = (id, visible) => document.getElementById(id).style.display = visible ? '' : 'none';

            show('field-vendor',    p === 'vscode-lm');
            show('field-effort',    p === 'anthropic');
            show('field-baseUrl',   p === 'ollama' || p === 'openai-compatible');
            show('field-maxTokens', p !== 'vscode-lm');
        }

        // Run on initial load
        updateProviderFields();

        // "Enter manually" link
        document.getElementById('modelManualLink').addEventListener('click', (e) => {
            e.preventDefault();
            useManualModel = true;
            document.getElementById('modelSelectWrap').style.display = 'none';
            document.getElementById('modelInputWrap').style.display = '';
            // Copy selected value to the text input
            const sel = document.getElementById('aiModelSelect');
            if (sel.value && sel.value !== '__default__') {
                document.getElementById('aiModel').value = sel.value;
            }
        });

        function fetchModels() {
            useManualModel = false;
            document.getElementById('modelSelectWrap').style.display = 'none';
            document.getElementById('modelInputWrap').style.display = 'none';
            document.getElementById('modelLoading').style.display = '';
            vscode.postMessage({
                command: 'fetchModels',
                provider: val('aiProvider'),
                baseUrl: val('aiBaseUrl'),
            });
        }

        function val(id) { return document.getElementById(id).value.trim(); }
        function num(id) { return Number(document.getElementById(id).value) || 0; }
        function chk(id) { return document.getElementById(id).checked; }

        function save() {
            vscode.postMessage({
                command: 'save',
                data: {
                    aiProvider: val('aiProvider'),
                    aiModel: useManualModel ? val('aiModel') : (document.getElementById('aiModelSelect').value === '__default__' ? '' : (document.getElementById('aiModelSelect').value || val('aiModel'))),
                    aiEffort: val('aiEffort'),
                    aiBaseUrl: val('aiBaseUrl'),
                    aiVendor: val('aiVendor'),
                    aiMaxTokens: num('aiMaxTokens'),
                    emailEnabled: chk('emailEnabled'),
                    smtpHost: val('smtpHost'),
                    smtpPort: num('smtpPort'),
                    smtpSecure: chk('smtpSecure'),
                    smtpUser: val('smtpUser'),
                    emailFromAddress: val('emailFromAddress'),
                    emailFromName: val('emailFromName'),
                    defaultRecipients: val('defaultRecipients'),
                    branchPrefix: val('branchPrefix'),
                    maxIterations: num('maxIterations'),
                    maxDiffLines: num('maxDiffLines'),
                    maxConcurrentIssues: num('maxConcurrentIssues'),
                    dryRun: chk('dryRun'),
                    autoStart: chk('autoStart'),
                    watchdogTimeout: num('watchdogTimeout'),
                    labelApproved: val('labelApproved'),
                    labelRejected: val('labelRejected'),
                    labelNeedsReview: val('labelNeedsReview'),
                    labelSubversion: val('labelSubversion'),
                    threatThreshold: Number(val('threatThreshold')),
                    blockThreshold: Number(val('blockThreshold')),
                    reportOnBlock: chk('reportOnBlock'),
                    deleteHostile: chk('deleteHostile'),
                    reEvalOnEdit: chk('reEvalOnEdit'),
                    maxInputLength: num('maxInputLength'),
                    rlComments: num('rlComments'),
                    rlBranches: num('rlBranches'),
                    rlPrs: num('rlPrs'),
                    rlPushes: num('rlPushes'),
                    rlBlocks: num('rlBlocks'),
                    rlLlm: num('rlLlm'),
                    rlIssues: num('rlIssues'),
                    rlQueueDepth: num('rlQueueDepth'),
                },
            });
        }

        function setApiKey() {
            document.getElementById('modelNoKey').style.display = 'none';
            document.getElementById('modelLoading').style.display = '';
            vscode.postMessage({
                command: 'setApiKey',
                provider: val('aiProvider'),
                baseUrl: val('aiBaseUrl'),
            });
        }

        function setSmtpPassword() {
            vscode.postMessage({ command: 'setSmtpPassword' });
        }

        function cancel() {
            vscode.postMessage({ command: 'cancel' });
        }

        // Handle messages from the extension
        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.command === 'smtpPasswordSet') {
                document.getElementById('smtpPasswordStatus').textContent = '\u2713 Saved';
            }
            if (msg.command === 'modelsLoaded') {
                document.getElementById('modelLoading').style.display = 'none';
                const models = msg.models || [];
                if (models.length === 0 || useManualModel) {
                    // No models found — show text input with a helpful reason
                    document.getElementById('modelInputWrap').style.display = '';
                    document.getElementById('modelNoKey').style.display = 'none';
                    if (msg.reason === 'no-key') {
                        // Show the Set API Key button instead of the text input
                        document.getElementById('modelInputWrap').style.display = 'none';
                        document.getElementById('modelNoKey').style.display = '';
                        document.getElementById('modelNoKeyHelp').textContent =
                            'No API key stored for ' + (msg.providerLabel || 'this provider') + '.';
                        return;
                    }
                    let hint = 'e.g. claude-opus-5, gpt-4o, gemini-2.0-flash, llama3.1';
                    if (msg.reason === 'fetch-failed') {
                        hint = 'Could not fetch models'
                             + (msg.detail ? ': ' + msg.detail : '')
                             + '. Type a model name, or leave blank for the provider default.';
                    }
                    document.getElementById('modelInputHelp').textContent = hint;
                    return;
                }
                // Populate the select
                const sel = document.getElementById('aiModelSelect');
                sel.innerHTML = '';
                const defaultOpt = document.createElement('option');
                defaultOpt.value = '__default__';
                defaultOpt.textContent = '(provider default)';
                sel.appendChild(defaultOpt);
                let foundCurrent = false;
                models.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m.id;
                    opt.textContent = m.label + (m.detail ? ' — ' + m.detail : '');
                    if (m.id === currentModel) {
                        opt.selected = true;
                        foundCurrent = true;
                    }
                    sel.appendChild(opt);
                });
                if (!foundCurrent && currentModel) {
                    defaultOpt.selected = false;
                    const customOpt = document.createElement('option');
                    customOpt.value = currentModel;
                    customOpt.textContent = currentModel + ' (current, not in list)';
                    customOpt.selected = true;
                    sel.insertBefore(customOpt, sel.children[1]);
                }
                document.getElementById('modelSelectWrap').style.display = '';
                document.getElementById('modelInputWrap').style.display = 'none';
                document.getElementById('modelNoKey').style.display = 'none';
                // If using fallback list, show a note
                const manualLink = document.getElementById('modelManualLink');
                if (msg.fallback) {
                    manualLink.textContent = 'Common models shown \u2014 set an API key to see your full catalogue, or enter manually';
                } else {
                    manualLink.textContent = 'Enter manually instead';
                }
            }
        });

        // Fetch models on initial load
        fetchModels();

        // Ctrl+S to save
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

    private esc(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
}
