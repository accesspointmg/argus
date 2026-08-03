// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Claude, via the official Anthropic SDK.
 *
 * Three choices here are specific to what Argus does, and worth stating:
 *
 *   Adaptive thinking is on. Judging whether an issue is legitimate, or whether
 *   a diff from a stranger is hostile, is exactly the kind of work that benefits
 *   from it. Claude decides per request how much to spend.
 *
 *   Requests stream. Not to show progress — nothing renders these tokens — but
 *   because a non-streaming request with a large `max_tokens` can outlive the
 *   HTTP timeout. `finalMessage()` gives back the assembled reply.
 *
 *   Refusals fall back to another model. Argus deliberately feeds Claude
 *   attacker-supplied text, and the cyber safeguards on the current models
 *   sometimes decline it. `fallbacks: 'default'` re-runs a declined request
 *   server-side on Anthropic's recommended substitute, so a false positive on a
 *   genuine security review costs a little latency instead of the whole
 *   assessment. A refusal that survives the fallback is surfaced as
 *   {@link LlmRefusalError} — callers with a conservative default should use it.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ChatRequest, EffortLevel, LlmProvider, ModelInfo, ProviderId } from '../types';
import { LlmRefusalError } from '../types';
import { formatContext } from './http';

/**
 * Model used when `argus.ai.model` is empty.
 *
 * Opus is the right default for adversarial review: the failure this tool
 * exists to prevent is a subtly hostile change slipping past, which is a
 * reasoning problem, not a throughput one.
 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';

/** Enables the `fallbacks` parameter below. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Models known to support the server-side fallback beta.
 * Others get the request without `fallbacks` / `betas` so they don't 400.
 */
const FALLBACK_ELIGIBLE_MODELS = new Set([
    'claude-opus-5',
    'claude-sonnet-4-20250514',
]);

export interface AnthropicOptions {
    apiKey: string;
    model?: string;
    /** For gateways and proxies that speak the Anthropic API. */
    baseUrl?: string;
    defaultMaxTokens: number;
    /** Omit to use the model's own default (`high` on current models). */
    effort?: EffortLevel;
}

export class AnthropicProvider implements LlmProvider {
    readonly id: ProviderId = 'anthropic';

    private readonly client: Anthropic;
    private readonly model: string;

    constructor(private readonly options: AnthropicOptions) {
        this.model = options.model || DEFAULT_ANTHROPIC_MODEL;
        this.client = new Anthropic({
            apiKey: options.apiKey,
            ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
        });
    }

    get label(): string {
        const effort = this.options.effort ? `, ${this.options.effort} effort` : '';
        return `anthropic (${this.model}${effort})`;
    }

    async isAvailable(): Promise<boolean> {
        // A key is the only precondition we can check without spending money.
        return Boolean(this.options.apiKey);
    }

    /**
     * The catalogue this key can reach, newest first.
     *
     * Anthropic's listing returns only chat models, so nothing needs filtering
     * out — unlike OpenAI, where embeddings and audio models share the route.
     */
    async listModels(): Promise<ModelInfo[]> {
        const models: ModelInfo[] = [];
        for await (const model of this.client.models.list({ limit: 100 })) {
            models.push({
                id: model.id,
                label: model.display_name || model.id,
                detail: formatContext(model.max_input_tokens),
            });
        }
        return models;
    }

    async chat(request: ChatRequest): Promise<string> {
        const useFallback = FALLBACK_ELIGIBLE_MODELS.has(this.model);

        const params: Record<string, unknown> = {
            model: this.model,
            max_tokens: request.maxTokens ?? this.options.defaultMaxTokens,
            ...(request.system ? { system: request.system } : {}),
            messages: request.messages.map((m) => ({ role: m.role, content: m.text })),
            thinking: { type: 'adaptive' },
            ...(this.options.effort ? { output_config: { effort: this.options.effort } } : {}),
            ...(useFallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
        };

        // Use beta stream when fallback is enabled, regular stream otherwise.
        const stream = useFallback
            ? this.client.beta.messages.stream(params as any)
            : this.client.messages.stream(params as any);

        const message = await stream.finalMessage();

        // Check before reading content: on a refusal the content array is empty
        // or holds a partial, and treating either as a real answer would let a
        // declined request read as "nothing suspicious found".
        if (message.stop_reason === 'refusal') {
            const details = (message as any).stop_details;
            const category = details?.type === 'refusal' ? details.category ?? undefined : undefined;
            throw new LlmRefusalError(
                `${this.model} declined the request` +
                `${category ? ` (${category})` : ''}` +
                (useFallback ? ' and the fallback model did not answer it either.' : '.'),
                category,
            );
        }

        // Thinking blocks are dropped — callers want the answer, and on current
        // models the raw reasoning is not returned anyway.
        return (message.content as any[])
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text)
            .join('');
    }
}
