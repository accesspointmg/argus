// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Google Gemini, via the Generative Language REST API.
 *
 * Gemini is the one provider here that does not resemble the others: turns live
 * under `contents` rather than `messages`, the assistant role is called `model`,
 * text is nested in `parts`, and the key travels in a header rather than a
 * bearer token. The translation is confined to this file.
 */

import type { ChatRequest, LlmProvider, ModelInfo, ProviderId } from '../types';
import { formatContext, getJson, postJson, trimBaseUrl } from './http';

export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';

interface ModelListResponse {
    models?: Array<{
        name?: string;
        displayName?: string;
        inputTokenLimit?: number;
        supportedGenerationMethods?: string[];
    }>;
}

interface GenerateContentResponse {
    candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
    }>;
    promptFeedback?: { blockReason?: string };
}

export interface GeminiOptions {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    defaultMaxTokens: number;
}

export class GeminiProvider implements LlmProvider {
    readonly id: ProviderId = 'gemini';

    private readonly baseUrl: string;
    private readonly model: string;

    constructor(private readonly options: GeminiOptions) {
        this.baseUrl = trimBaseUrl(options.baseUrl || DEFAULT_GEMINI_BASE_URL);
        this.model = options.model || DEFAULT_GEMINI_MODEL;
    }

    get label(): string {
        return `gemini (${this.model})`;
    }

    async isAvailable(): Promise<boolean> {
        return Boolean(this.options.apiKey);
    }

    /**
     * Models that can actually answer a `generateContent` call.
     *
     * Gemini's listing includes embedding and token-counting models, but unlike
     * OpenAI it says so explicitly in `supportedGenerationMethods` — so this
     * filters on the declared capability rather than guessing from the name.
     * Ids come back prefixed (`models/gemini-2.0-flash`); the prefix is dropped
     * because the request path adds it again.
     */
    async listModels(): Promise<ModelInfo[]> {
        const result = await getJson<ModelListResponse>({
            url: `${this.baseUrl}/v1beta/models?pageSize=200`,
            headers: { 'x-goog-api-key': this.options.apiKey },
        });

        return (result.models ?? [])
            .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
            .map((m) => {
                const id = (m.name ?? '').replace(/^models\//, '');
                return {
                    id,
                    label: m.displayName || id,
                    detail: formatContext(m.inputTokenLimit),
                };
            })
            .filter((m) => m.id.length > 0);
    }

    async chat(request: ChatRequest): Promise<string> {
        const body = {
            ...(request.system
                ? { systemInstruction: { parts: [{ text: request.system }] } }
                : {}),
            contents: request.messages.map((m) => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.text }],
            })),
            generationConfig: {
                maxOutputTokens: request.maxTokens ?? this.options.defaultMaxTokens,
            },
        };

        const result = await postJson<GenerateContentResponse>({
            url: `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
            body,
            headers: { 'x-goog-api-key': this.options.apiKey },
            token: request.token,
        });

        // Gemini reports a blocked prompt with no candidates at all, so an empty
        // reply and a safety block look alike until you check `promptFeedback`.
        const blocked = result.promptFeedback?.blockReason;
        if (blocked) {
            throw new Error(`${this.label} blocked the prompt (${blocked})`);
        }

        const text = (result.candidates?.[0]?.content?.parts ?? [])
            .map((part) => part.text ?? '')
            .join('');
        if (!text) {
            const reason = result.candidates?.[0]?.finishReason;
            throw new Error(
                `${this.label} returned no text${reason ? ` (finishReason: ${reason})` : ''}`,
            );
        }
        return text;
    }
}
