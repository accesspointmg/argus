// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Interactive configuration for the AI provider.
 *
 * Backing the two commands "Argus: Select AI Provider" and "Argus: Set AI
 * Provider Key". The flow is provider → endpoint → key → model → effort, and
 * that order is load-bearing: the model list is fetched from the vendor, which
 * cannot happen before the key exists. Asking for the model first is what
 * forces someone to type `claude-opus-5` from memory and discover the typo as
 * a 404 on their first real issue.
 *
 * Discovery is best-effort throughout. A vendor that is unreachable, a key that
 * is wrong, a self-hosted server with no listing route — each falls back to a
 * plain text box rather than blocking setup. Nothing here should be able to
 * leave someone unable to configure Argus because a catalogue endpoint was
 * down.
 */

import * as vscode from 'vscode';
import type { EffortLevel, ModelInfo, ProviderId } from './types';
import { EFFORT_LEVELS } from './types';
import { apiKeyStorageKey, createProvider, providerNeedsKey, readAiSettings } from './service';

interface ProviderChoice {
    id: ProviderId;
    label: string;
    detail: string;
    /** Where to get a key, shown when prompting for one. */
    keyHint?: string;
    /** Placeholder for the model box, used when discovery fails. */
    modelHint?: string;
    /** Whether this provider is configured by base URL. */
    needsBaseUrl?: boolean;
    /** Whether this provider honors `argus.ai.effort`. */
    supportsEffort?: boolean;
}

const CHOICES: ProviderChoice[] = [
    {
        id: 'vscode-lm',
        label: 'VS Code (Copilot or another extension)',
        detail: 'Uses a model VS Code already provides. No API key needed.',
        modelHint: 'gpt-4o (optional — blank uses the vendor default)',
    },
    {
        id: 'anthropic',
        label: 'Anthropic (Claude)',
        detail: 'Direct API access to Claude. Supports an effort setting.',
        keyHint: 'console.anthropic.com → API keys',
        modelHint: 'claude-opus-5 (optional)',
        supportsEffort: true,
    },
    {
        id: 'openai',
        label: 'OpenAI',
        detail: 'Direct API access to GPT models.',
        keyHint: 'platform.openai.com → API keys',
        modelHint: 'gpt-4o (optional)',
    },
    {
        id: 'gemini',
        label: 'Google Gemini',
        detail: 'Direct API access to Gemini models.',
        keyHint: 'aistudio.google.com → Get API key',
        modelHint: 'gemini-2.0-flash (optional)',
    },
    {
        id: 'ollama',
        label: 'Ollama (local)',
        detail: 'A model on this machine. Nothing leaves the host, no key needed.',
        modelHint: 'llama3.1 (optional)',
        needsBaseUrl: true,
    },
    {
        id: 'openai-compatible',
        label: 'Other (OpenAI-compatible endpoint)',
        detail: 'Groq, Together, OpenRouter, vLLM, LM Studio, a gateway — anything speaking the OpenAI API.',
        keyHint: 'whatever your endpoint expects — leave blank if it needs none',
        modelHint: 'the model name your endpoint expects',
        needsBaseUrl: true,
    },
];

/** Effort levels, described in terms of the tradeoff rather than the word. */
const EFFORT_DETAIL: Record<EffortLevel, string> = {
    low: 'Fastest and cheapest. Fine for classification, thin on hard judgement calls.',
    medium: 'Reduced token use, some loss of depth.',
    high: 'The provider default. Balanced.',
    xhigh: 'Recommended for coding and agentic work. More thorough, more tokens.',
    max: 'Deepest reasoning, highest cost. Can overthink simple tasks.',
};

function choiceFor(id: ProviderId): ProviderChoice {
    return CHOICES.find((c) => c.id === id) ?? CHOICES[0];
}

/**
 * Ask which provider to use, then collect whatever that choice needs.
 *
 * Writes to the global settings scope: Argus polls repositories in the
 * background, so its model belongs to the user rather than to whichever folder
 * happens to be open.
 */
export async function selectAiProvider(secrets: vscode.SecretStorage): Promise<void> {
    const current = readAiSettings();

    const picked = await vscode.window.showQuickPick(
        CHOICES.map((c) => ({
            label: c.id === current.provider ? `$(check) ${c.label}` : c.label,
            detail: c.detail,
            choice: c,
        })),
        { title: 'Argus: Select AI Provider', placeHolder: 'Which AI should Argus use?' },
    );
    if (!picked) { return; }

    const choice = picked.choice;
    const cfg = vscode.workspace.getConfiguration('argus');
    await cfg.update('ai.provider', choice.id, vscode.ConfigurationTarget.Global);

    // ── Endpoint ────────────────────────────────────────────────
    let baseUrl = current.baseUrl;
    if (choice.needsBaseUrl) {
        const suggested = choice.id === 'ollama' ? 'http://localhost:11434' : '';
        const entered = await vscode.window.showInputBox({
            title: `${choice.label} — endpoint`,
            prompt: choice.id === 'ollama'
                ? 'Ollama server URL (blank uses http://localhost:11434)'
                : 'Base URL of the OpenAI-compatible API, including any /v1 suffix',
            value: current.baseUrl || suggested,
            ignoreFocusOut: true,
        });
        if (entered === undefined) { return; }
        baseUrl = entered.trim();
        await cfg.update('ai.baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
    }

    // ── Key, before the model, so the catalogue can be fetched ──
    let apiKey = '';
    if (providerNeedsKey(choice.id)) {
        apiKey = (await secrets.get(apiKeyStorageKey(choice.id))) ?? '';
        if (!apiKey) {
            const entered = await promptAndStoreApiKey(secrets, choice.id);
            if (entered === undefined) { return; }
            apiKey = entered;
        }
    }

    // ── Model ───────────────────────────────────────────────────
    const model = await pickModel(choice, { ...current, baseUrl, model: '' }, apiKey);
    if (model === undefined) { return; }
    await cfg.update('ai.model', model, vscode.ConfigurationTarget.Global);

    // ── Effort ──────────────────────────────────────────────────
    if (choice.supportsEffort) {
        const effort = await pickEffort(current.effort);
        if (effort !== undefined) {
            await cfg.update('ai.effort', effort, vscode.ConfigurationTarget.Global);
        }
    }

    vscode.window.showInformationMessage(
        `Argus will use ${choice.label}${model ? ` · ${model}` : ''}.`,
    );
}

/**
 * Offer the vendor's catalogue, falling back to free text.
 *
 * Returns the chosen model id, `''` for "use the provider's default", or
 * `undefined` if the user dismissed — which aborts the whole flow rather than
 * silently leaving a half-configured provider.
 */
async function pickModel(
    choice: ProviderChoice,
    settings: ReturnType<typeof readAiSettings>,
    apiKey: string,
): Promise<string | undefined> {
    const models = await discoverModels(choice.id, settings, apiKey);

    if (models.length === 0) {
        const entered = await vscode.window.showInputBox({
            title: `${choice.label} — model`,
            prompt: 'Could not reach the model list. Type a model name, or leave blank for the default.',
            value: settings.model,
            placeHolder: choice.modelHint,
            ignoreFocusOut: true,
        });
        return entered?.trim();
    }

    const MANUAL = '$(edit) Enter a model name manually…';
    const DEFAULT = '$(star) Use this provider\'s default';

    const items: vscode.QuickPickItem[] = [
        { label: DEFAULT, detail: 'Recommended unless you have a reason to pin one' },
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        ...models.map((m) => ({
            label: m.id === settings.model ? `$(check) ${m.label}` : m.label,
            description: m.label === m.id ? undefined : m.id,
            detail: m.detail,
        })),
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: MANUAL },
    ];

    const picked = await vscode.window.showQuickPick(items, {
        title: `${choice.label} — model`,
        placeHolder: `${models.length} model(s) available`,
        matchOnDescription: true,
    });
    if (!picked) { return undefined; }
    if (picked.label === DEFAULT) { return ''; }

    if (picked.label === MANUAL) {
        const entered = await vscode.window.showInputBox({
            title: `${choice.label} — model`,
            prompt: 'Model name to send to the provider',
            value: settings.model,
            placeHolder: choice.modelHint,
            ignoreFocusOut: true,
        });
        return entered?.trim();
    }

    // `description` holds the id whenever it differs from the display name.
    return picked.description ?? picked.label.replace(/^\$\(check\) /, '');
}

/** Ask the vendor what it offers; never throws. */
async function discoverModels(
    provider: ProviderId,
    settings: ReturnType<typeof readAiSettings>,
    apiKey: string,
): Promise<ModelInfo[]> {
    return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Argus: fetching available models…' },
        async () => {
            try {
                const built = createProvider({ ...settings, provider }, apiKey);
                return (await built.listModels?.()) ?? [];
            } catch (err) {
                // A bad key, an unreachable host, or a server with no listing
                // route. None of those should stop someone configuring Argus.
                console.warn(`Argus: model discovery failed for ${provider}: ${err}`);
                return [];
            }
        },
    );
}

/** Returns the raw setting value: an effort level, or `'default'`. */
async function pickEffort(current: EffortLevel | undefined): Promise<string | undefined> {
    const DEFAULT_LABEL = 'Model default';
    const picked = await vscode.window.showQuickPick(
        [
            {
                label: current === undefined ? `$(check) ${DEFAULT_LABEL}` : DEFAULT_LABEL,
                detail: 'Let the model decide. Recommended.',
                value: 'default',
            },
            ...EFFORT_LEVELS.map((level) => ({
                label: level === current ? `$(check) ${level}` : level,
                detail: EFFORT_DETAIL[level],
                value: level as string,
            })),
        ],
        {
            title: 'Argus: effort level',
            placeHolder: 'How hard should the model think? Affects quality, latency and cost.',
        },
    );
    return picked?.value;
}

/**
 * Prompt for an API key and put it in SecretStorage.
 *
 * Keys are stored per provider, so switching back and forth does not mean
 * re-entering them. Returns the key (possibly `''` for an endpoint that needs
 * none), or `undefined` if the user dismissed.
 */
export async function promptAndStoreApiKey(
    secrets: vscode.SecretStorage,
    provider?: ProviderId,
): Promise<string | undefined> {
    let target = provider;
    if (!target) {
        const picked = await vscode.window.showQuickPick(
            CHOICES.filter((c) => providerNeedsKey(c.id)).map((c) => ({
                label: c.label,
                detail: c.detail,
                choice: c,
            })),
            { title: 'Argus: Set AI Provider Key', placeHolder: 'Which provider\'s key?' },
        );
        if (!picked) { return undefined; }
        target = picked.choice.id;
    }

    const choice = choiceFor(target);
    const optional = target === 'openai-compatible';

    const entered = await vscode.window.showInputBox({
        title: `Set ${choice.label} API Key`,
        prompt: choice.keyHint ? `Get one from ${choice.keyHint}` : 'Enter the API key',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) =>
            optional || v.trim() ? undefined : 'Key cannot be empty',
    });
    if (entered === undefined) { return undefined; }

    const key = entered.trim();
    if (key) {
        await secrets.store(apiKeyStorageKey(target), key);
        vscode.window.showInformationMessage(`${choice.label} key stored.`);
    } else {
        // An endpoint that needs no key: clear any stale one rather than
        // leaving a credential behind that nothing will use.
        await secrets.delete(apiKeyStorageKey(target));
    }
    return key;
}
