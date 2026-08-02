// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * OpenAI, and the many servers that copied its chat-completions shape.
 *
 * One class covers both because the wire format is identical; only the endpoint
 * and the token-limit field differ. That second difference is not cosmetic —
 * OpenAI's newer reasoning models reject `max_tokens` and require
 * `max_completion_tokens`, while most self-hosted servers (Ollama's OpenAI
 * shim, llama.cpp, vLLM, LM Studio) only understand the older `max_tokens`.
 * Sending the wrong one is a 400, so the provider id decides.
 *
 * `openai-compatible` is the escape hatch for everything not enumerated in the
 * settings: Groq, Together, OpenRouter, DeepSeek, Azure deployments, a local
 * server. Point `argus.ai.baseUrl` at it and it works.
 */

import type { ChatRequest, LlmProvider, ModelInfo, ProviderId } from '../types';
import { LlmUnavailableError } from '../types';
import { getJson, postJson, trimBaseUrl } from './http';

/**
 * Model ids that share the listing route but cannot hold a conversation.
 *
 * OpenAI returns embeddings, speech, transcription, image and moderation
 * models from the same endpoint, and a picker full of `text-embedding-3-large`
 * is worse than no picker. Matched loosely because the catalogue changes often
 * — a new chat model wrongly hidden is recoverable via manual entry, whereas an
 * embedding model offered as a chat option is a confusing 400 later.
 */
const NON_CHAT_MODEL = /embedding|whisper|^tts|audio|realtime|moderation|dall-e|image|search|similarity|edit|davinci|babbage|ada|curie/i;

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o';

interface ChatCompletionResponse {
    choices?: Array<{ message?: { content?: string | null } }>;
}

interface ModelListResponse {
    data?: Array<{ id?: string; owned_by?: string }>;
}

export interface OpenAiOptions {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    defaultMaxTokens: number;
    /** `openai` targets the hosted API; `openai-compatible` targets a custom base URL. */
    variant: 'openai' | 'openai-compatible';
}

export class OpenAiProvider implements LlmProvider {
    readonly id: ProviderId;

    private readonly baseUrl: string;
    private readonly model: string;

    constructor(private readonly options: OpenAiOptions) {
        this.id = options.variant;
        this.baseUrl = trimBaseUrl(options.baseUrl || DEFAULT_OPENAI_BASE_URL);
        this.model = options.model || DEFAULT_OPENAI_MODEL;
    }

    get label(): string {
        return `${this.id} (${this.model})`;
    }

    async isAvailable(): Promise<boolean> {
        if (this.options.variant === 'openai-compatible') {
            // A custom endpoint is the whole configuration; some need no key at all.
            return Boolean(this.options.baseUrl);
        }
        return Boolean(this.options.apiKey);
    }

    /**
     * Chat models this endpoint offers.
     *
     * Filtering is applied to the hosted API, whose catalogue is known to mix
     * in embeddings and audio. A custom endpoint is left unfiltered: it may
     * serve a single model under a name that looks nothing like OpenAI's, and
     * hiding the only available option would be worse than showing an odd one.
     */
    async listModels(): Promise<ModelInfo[]> {
        const result = await getJson<ModelListResponse>({
            url: `${this.baseUrl}/models`,
            headers: this.options.apiKey
                ? { authorization: `Bearer ${this.options.apiKey}` }
                : {},
        });

        const ids = (result.data ?? [])
            .map((m) => m.id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);

        const usable = this.options.variant === 'openai'
            ? ids.filter((id) => !NON_CHAT_MODEL.test(id))
            : ids;

        return usable.sort().map((id) => ({ id, label: id }));
    }

    async chat(request: ChatRequest): Promise<string> {
        if (this.options.variant === 'openai-compatible' && !this.options.baseUrl) {
            throw new LlmUnavailableError(
                'Set argus.ai.baseUrl to the endpoint of your OpenAI-compatible server.',
            );
        }

        const maxTokens = request.maxTokens ?? this.options.defaultMaxTokens;
        const messages = [
            ...(request.system ? [{ role: 'system', content: request.system }] : []),
            ...request.messages.map((m) => ({ role: m.role, content: m.text })),
        ];

        const body = {
            model: this.model,
            messages,
            ...(this.options.variant === 'openai'
                ? { max_completion_tokens: maxTokens }
                : { max_tokens: maxTokens }),
        };

        const result = await postJson<ChatCompletionResponse>({
            url: `${this.baseUrl}/chat/completions`,
            body,
            headers: this.options.apiKey
                ? { authorization: `Bearer ${this.options.apiKey}` }
                : {},
            token: request.token,
        });

        const text = result.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || text.length === 0) {
            throw new Error(`${this.label} returned no message content`);
        }
        return text;
    }
}
