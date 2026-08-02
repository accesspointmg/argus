// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Turns `argus.ai.*` settings plus a stored key into a live {@link LlmProvider}.
 *
 * Every part of Argus that needs a model holds one of these rather than
 * choosing a vendor itself, so switching provider is a settings change and not
 * a code change. The service is constructed once at activation and injected;
 * it re-resolves whenever the settings that matter change, so a user who
 * switches from Copilot to Claude mid-session does not have to reload the
 * window.
 *
 * API keys are read from SecretStorage on each resolve and kept only inside the
 * provider instance. Nothing here logs them, and `label` is deliberately the
 * only thing exposed for diagnostics.
 */

import * as vscode from 'vscode';
import type { ChatRequest, EffortLevel, LlmProvider, ProviderId } from './types';
import { EFFORT_LEVELS, KEYED_PROVIDERS, LlmUnavailableError, PROVIDER_IDS } from './types';
import type { Logger } from '../util/logger';
import { LlmThrottle } from './throttle';
import { VsCodeLmProvider } from './providers/vscode-lm';
import { AnthropicProvider } from './providers/anthropic';
import { OpenAiProvider } from './providers/openai';
import { GeminiProvider } from './providers/gemini';
import { OllamaProvider } from './providers/ollama';

/**
 * Default reply ceiling.
 *
 * Generous because `Coder` returns whole file contents as JSON, and a truncated
 * reply there is a parse failure rather than a shorter answer. It is a cap, not
 * a reservation — short replies cost what they cost.
 */
const DEFAULT_MAX_TOKENS = 32_000;

/** Secret-storage key holding the API key for a given provider. */
export function apiKeyStorageKey(provider: ProviderId): string {
    return `argus.ai.key.${provider}`;
}

/** Whether a provider authenticates with a key Argus has to store. */
export function providerNeedsKey(provider: ProviderId): boolean {
    return KEYED_PROVIDERS.includes(provider);
}

/** Model calls per hour when `argus.rateLimits.llmCallsPerHour` is unset. */
const DEFAULT_CALLS_PER_HOUR = 100;

export interface AiSettings {
    provider: ProviderId;
    model: string;
    baseUrl: string;
    vendor: string;
    maxTokens: number;
    callsPerHour: number;
    /** Undefined means "use the model default". */
    effort?: EffortLevel;
}

export function readAiSettings(): AiSettings {
    const cfg = vscode.workspace.getConfiguration('argus');
    const configured = cfg.get<string>('ai.provider', 'vscode-lm');
    const provider = (PROVIDER_IDS as readonly string[]).includes(configured)
        ? (configured as ProviderId)
        : 'vscode-lm';

    return {
        provider,
        model: (cfg.get<string>('ai.model', '') || '').trim(),
        baseUrl: (cfg.get<string>('ai.baseUrl', '') || '').trim(),
        vendor: (cfg.get<string>('ai.vendor', 'copilot') || 'copilot').trim(),
        maxTokens: cfg.get<number>('ai.maxTokens', DEFAULT_MAX_TOKENS),
        callsPerHour: cfg.get<number>('rateLimits.llmCallsPerHour', DEFAULT_CALLS_PER_HOUR),
        effort: readEffort(cfg.get<string>('ai.effort', 'default')),
    };
}

export class LlmService {
    private cached?: { key: string; provider: LlmProvider };
    private readonly throttle: LlmThrottle;

    constructor(
        private readonly secrets: vscode.SecretStorage,
        private readonly logger: Logger,
    ) {
        this.throttle = new LlmThrottle(readAiSettings().callsPerHour);
    }

    /** Model calls still available this hour. */
    remainingCalls(): number {
        return this.throttle.remaining();
    }

    /**
     * The configured provider.
     *
     * Cached against a fingerprint of the settings and the presence of a key,
     * so repeated calls do not re-read SecretStorage, but a settings change
     * still takes effect on the next request.
     */
    async provider(): Promise<LlmProvider> {
        const settings = readAiSettings();
        const apiKey = providerNeedsKey(settings.provider)
            ? (await this.secrets.get(apiKeyStorageKey(settings.provider))) ?? ''
            : '';

        // Serialized rather than joined on a delimiter: settings are free text,
        // and a value containing the delimiter could forge another
        // configuration's fingerprint — which would keep serving a stale
        // provider after the user changed something.
        const fingerprint = JSON.stringify([
            settings.provider,
            settings.model,
            settings.baseUrl,
            settings.vendor,
            settings.maxTokens,
            settings.effort ?? null,
            apiKey ? 'keyed' : 'unkeyed',
        ]);

        if (this.cached?.key === fingerprint) {
            return this.cached.provider;
        }

        const provider = this.build(settings, apiKey);
        this.cached = { key: fingerprint, provider };
        this.logger.info(`AI provider resolved: ${provider.label}`);
        return provider;
    }

    /**
     * Whether a model can be reached.
     *
     * Callers that degrade gracefully should branch on this rather than
     * catching from {@link chat}, so a genuine transport failure stays
     * distinguishable from "not configured".
     */
    async isAvailable(): Promise<boolean> {
        try {
            return await (await this.provider()).isAvailable();
        } catch (err) {
            this.logger.debug(`AI provider unavailable: ${err}`);
            return false;
        }
    }

    /**
     * Send a conversation to the configured provider and return the reply text.
     *
     * This is the only path to a model in Argus, which is what makes the hourly
     * call budget enforceable. The budget is claimed before the request goes
     * out, so a provider error still costs a slot — the limit is there to bound
     * how hard Argus hammers an endpoint, and a failing endpoint is exactly
     * when that matters.
     */
    async chat(request: ChatRequest): Promise<string> {
        if (request.messages.length === 0) {
            throw new Error('chat() requires at least one message');
        }

        const provider = await this.provider();

        this.throttle.configure(readAiSettings().callsPerHour);
        try {
            this.throttle.claim();
        } catch (err) {
            this.logger.warn(String(err));
            throw err;
        }

        return provider.chat(request);
    }

    /** Provider and model, for logs and audit entries. Never includes a key. */
    async describe(): Promise<string> {
        try {
            return (await this.provider()).label;
        } catch {
            return 'none';
        }
    }

    private build(settings: AiSettings, apiKey: string): LlmProvider {
        return createProvider(settings, apiKey);
    }
}

// ─── Construction ───────────────────────────────────────────────

/**
 * Build a provider from an explicit configuration.
 *
 * Separate from {@link LlmService} because the setup flow needs a provider
 * *before* the settings are committed — it builds one from the half-collected
 * answers purely to ask it which models exist. Going through the service would
 * mean writing settings first and rolling them back if the user cancels.
 *
 * Throws {@link LlmUnavailableError} when the configuration cannot produce a
 * working provider (missing key, missing endpoint).
 */
export function createProvider(settings: AiSettings, apiKey: string): LlmProvider {
    const defaultMaxTokens = settings.maxTokens;

    const requireKey = (label: string): void => {
        if (!apiKey) {
            throw new LlmUnavailableError(
                `No ${label} API key stored. Run "Argus: Set AI Provider Key".`,
            );
        }
    };

    switch (settings.provider) {
        case 'vscode-lm':
            return new VsCodeLmProvider({
                vendor: settings.vendor || 'copilot',
                family: settings.model || undefined,
            });

        case 'anthropic':
            requireKey('Anthropic');
            return new AnthropicProvider({
                apiKey,
                model: settings.model,
                baseUrl: settings.baseUrl,
                defaultMaxTokens,
                effort: settings.effort,
            });

        case 'openai':
            requireKey('OpenAI');
            return new OpenAiProvider({
                apiKey,
                model: settings.model,
                baseUrl: settings.baseUrl,
                defaultMaxTokens,
                variant: 'openai',
            });

        case 'openai-compatible':
            if (!settings.baseUrl) {
                throw new LlmUnavailableError(
                    'Set argus.ai.baseUrl to your OpenAI-compatible endpoint.',
                );
            }
            return new OpenAiProvider({
                apiKey,
                model: settings.model,
                baseUrl: settings.baseUrl,
                defaultMaxTokens,
                variant: 'openai-compatible',
            });

        case 'gemini':
            requireKey('Gemini');
            return new GeminiProvider({
                apiKey,
                model: settings.model,
                baseUrl: settings.baseUrl,
                defaultMaxTokens,
            });

        case 'ollama':
            return new OllamaProvider({
                model: settings.model,
                baseUrl: settings.baseUrl,
                defaultMaxTokens,
            });
    }
}

/** Validate the raw `argus.ai.effort` string; anything unrecognized means "model default". */
function readEffort(raw: string | undefined): EffortLevel | undefined {
    return (EFFORT_LEVELS as readonly string[]).includes(raw ?? '')
        ? (raw as EffortLevel)
        : undefined;
}
