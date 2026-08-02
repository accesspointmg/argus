// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Ollama, for models running on your own machine.
 *
 * The only provider that needs no key and sends nothing off the host. That is
 * worth having in a tool like this: reviewing a private repository means
 * handing issue text and diffs to whichever model is configured, and some
 * repositories should not leave the building.
 *
 * Ollama also exposes an OpenAI-compatible endpoint, which the `openai-compatible`
 * provider can reach. This uses the native `/api/chat` route instead — no key
 * ceremony, and `num_predict` behaves the way Ollama documents it.
 */

import type { ChatRequest, LlmProvider, ModelInfo, ProviderId } from '../types';
import { getJson, postJson, trimBaseUrl } from './http';

export const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
export const DEFAULT_OLLAMA_MODEL = 'llama3.1';

interface OllamaChatResponse {
    message?: { content?: string };
    error?: string;
}

interface OllamaTagsResponse {
    models?: Array<{
        name?: string;
        size?: number;
        details?: { parameter_size?: string; quantization_level?: string };
    }>;
}

export interface OllamaOptions {
    model?: string;
    baseUrl?: string;
    defaultMaxTokens: number;
}

export class OllamaProvider implements LlmProvider {
    readonly id: ProviderId = 'ollama';

    private readonly baseUrl: string;
    private readonly model: string;

    constructor(private readonly options: OllamaOptions) {
        this.baseUrl = trimBaseUrl(options.baseUrl || DEFAULT_OLLAMA_BASE_URL);
        this.model = options.model || DEFAULT_OLLAMA_MODEL;
    }

    get label(): string {
        return `ollama (${this.model})`;
    }

    /**
     * Ask the daemon whether it is up.
     *
     * Unlike the hosted providers there is no key to test, and "is the server
     * running?" is the failure people actually hit. The check is a local HTTP
     * round trip with a short deadline, so it is cheap enough to do on demand.
     */
    async isAvailable(): Promise<boolean> {
        try {
            const response = await fetch(`${this.baseUrl}/api/tags`, {
                signal: AbortSignal.timeout(2000),
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    /**
     * Models pulled onto this machine.
     *
     * The most useful listing of the six, because it is exhaustive and
     * authoritative: Ollama can only run what has been pulled, so anything
     * absent here would fail at request time with "model not found". The size
     * and quantization are shown since that is what decides whether a model
     * will actually fit in the hardware.
     */
    async listModels(): Promise<ModelInfo[]> {
        const result = await getJson<OllamaTagsResponse>({ url: `${this.baseUrl}/api/tags` });

        return (result.models ?? [])
            .map((m) => m.name)
            .filter((name): name is string => typeof name === 'string' && name.length > 0)
            .sort()
            .map((name) => {
                const found = result.models?.find((m) => m.name === name);
                const parts = [
                    found?.details?.parameter_size,
                    found?.details?.quantization_level,
                ].filter(Boolean);
                return { id: name, label: name, detail: parts.join(' · ') || undefined };
            });
    }

    async chat(request: ChatRequest): Promise<string> {
        const result = await postJson<OllamaChatResponse>({
            url: `${this.baseUrl}/api/chat`,
            body: {
                model: this.model,
                messages: [
                    ...(request.system ? [{ role: 'system', content: request.system }] : []),
                    ...request.messages.map((m) => ({ role: m.role, content: m.text })),
                ],
                stream: false,
                options: { num_predict: request.maxTokens ?? this.options.defaultMaxTokens },
            },
            token: request.token,
        });

        // Ollama answers 200 with an `error` field for things like an unpulled
        // model, so a successful status is not proof of a successful generation.
        if (result.error) {
            throw new Error(`${this.label}: ${result.error}`);
        }

        const text = result.message?.content;
        if (!text) {
            throw new Error(`${this.label} returned no message content`);
        }
        return text;
    }
}
