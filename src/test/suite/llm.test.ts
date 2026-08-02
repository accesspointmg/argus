// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Tests for the provider abstraction.
 *
 * What matters here is translation. Each provider takes the same
 * {@link ChatRequest} and has to render it into a different wire format, and
 * the ways that goes wrong are quiet: a system prompt silently dropped, an
 * assistant turn sent under a role the vendor does not recognize, a token limit
 * in the field this particular endpoint ignores. None of those throw — they
 * just make the model answer a subtly different question than the one asked.
 * So the assertions are mostly about the request body, not the reply.
 *
 * The providers that reach the network through `fetch` are covered by stubbing
 * it. `vscode-lm`, `LlmService` and the setup commands import the real `vscode`
 * module and can only run inside the extension host, so they are not here.
 */

import * as assert from 'assert';
import { OpenAiProvider } from '../../llm/providers/openai';
import { GeminiProvider } from '../../llm/providers/gemini';
import { OllamaProvider } from '../../llm/providers/ollama';
import { LlmUnavailableError, assistant, user } from '../../llm/types';
import { formatContext } from '../../llm/providers/http';

// ─── fetch stubbing ─────────────────────────────────────────────

interface Capture {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
}

const realFetch = globalThis.fetch;

/** Record the next request and answer it with `reply`. */
function stubFetch(reply: unknown, init: { status?: number; text?: string } = {}): Capture[] {
    const captured: Capture[] = [];
    globalThis.fetch = (async (url: string | URL | Request, options?: RequestInit) => {
        captured.push({
            url: String(url),
            headers: (options?.headers ?? {}) as Record<string, string>,
            body: JSON.parse(String(options?.body ?? '{}')),
        });
        const status = init.status ?? 200;
        return {
            ok: status >= 200 && status < 300,
            status,
            statusText: 'Stub',
            json: async () => reply,
            text: async () => init.text ?? JSON.stringify(reply),
        } as Response;
    }) as typeof globalThis.fetch;
    return captured;
}

const OPENAI_REPLY = { choices: [{ message: { content: 'the answer' } }] };
const GEMINI_REPLY = { candidates: [{ content: { parts: [{ text: 'the answer' }] } }] };
const OLLAMA_REPLY = { message: { content: 'the answer' } };

suite('LLM providers', () => {
    teardown(() => { globalThis.fetch = realFetch; });

    // ─── OpenAI and compatible endpoints ────────────────────────

    test('OpenAI carries the system prompt as a system-role message', async () => {
        const seen = stubFetch(OPENAI_REPLY);
        const provider = new OpenAiProvider({
            apiKey: 'sk-test', defaultMaxTokens: 100, variant: 'openai',
        });

        const text = await provider.chat({ system: 'be careful', messages: [user('hello')] });

        assert.strictEqual(text, 'the answer');
        const messages = seen[0].body.messages as Array<{ role: string; content: string }>;
        assert.deepStrictEqual(messages, [
            { role: 'system', content: 'be careful' },
            { role: 'user', content: 'hello' },
        ]);
    });

    test('OpenAI omits the system message when there is no system prompt', async () => {
        const seen = stubFetch(OPENAI_REPLY);
        await new OpenAiProvider({ apiKey: 'sk-test', defaultMaxTokens: 100, variant: 'openai' })
            .chat({ messages: [user('hello')] });

        const messages = seen[0].body.messages as Array<{ role: string }>;
        assert.strictEqual(messages.length, 1);
        assert.strictEqual(messages[0].role, 'user');
    });

    test('OpenAI uses max_completion_tokens, compatible servers use max_tokens', async () => {
        // Not cosmetic: OpenAI's reasoning models reject `max_tokens`, and most
        // self-hosted servers have never heard of `max_completion_tokens`.
        // Either mistake is a 400, so the field is chosen by variant.
        const hosted = stubFetch(OPENAI_REPLY);
        await new OpenAiProvider({ apiKey: 'k', defaultMaxTokens: 512, variant: 'openai' })
            .chat({ messages: [user('hi')] });
        assert.strictEqual(hosted[0].body.max_completion_tokens, 512);
        assert.strictEqual(hosted[0].body.max_tokens, undefined);

        const local = stubFetch(OPENAI_REPLY);
        await new OpenAiProvider({
            apiKey: '', baseUrl: 'http://localhost:8000/v1',
            defaultMaxTokens: 512, variant: 'openai-compatible',
        }).chat({ messages: [user('hi')] });
        assert.strictEqual(local[0].body.max_tokens, 512);
        assert.strictEqual(local[0].body.max_completion_tokens, undefined);
    });

    test('a per-request maxTokens overrides the configured default', async () => {
        const seen = stubFetch(OPENAI_REPLY);
        await new OpenAiProvider({ apiKey: 'k', defaultMaxTokens: 100, variant: 'openai' })
            .chat({ messages: [user('hi')], maxTokens: 4096 });
        assert.strictEqual(seen[0].body.max_completion_tokens, 4096);
    });

    test('a compatible endpoint with no key sends no authorization header', async () => {
        // Local servers generally reject `Authorization: Bearer ` outright.
        const seen = stubFetch(OPENAI_REPLY);
        await new OpenAiProvider({
            apiKey: '', baseUrl: 'http://localhost:8000/v1',
            defaultMaxTokens: 100, variant: 'openai-compatible',
        }).chat({ messages: [user('hi')] });
        assert.ok(!('authorization' in seen[0].headers));
    });

    test('a trailing slash on the base URL does not double up in the path', async () => {
        const seen = stubFetch(OPENAI_REPLY);
        await new OpenAiProvider({
            apiKey: '', baseUrl: 'http://localhost:8000/v1/',
            defaultMaxTokens: 100, variant: 'openai-compatible',
        }).chat({ messages: [user('hi')] });
        assert.strictEqual(seen[0].url, 'http://localhost:8000/v1/chat/completions');
    });

    test('openai-compatible without a base URL reports it is unconfigured', async () => {
        const provider = new OpenAiProvider({
            apiKey: 'k', defaultMaxTokens: 100, variant: 'openai-compatible',
        });
        assert.strictEqual(await provider.isAvailable(), false);
        await assert.rejects(
            () => provider.chat({ messages: [user('hi')] }),
            LlmUnavailableError,
        );
    });

    test('an empty completion is an error rather than an empty verdict', async () => {
        // Callers check the reply for a canary and parse JSON out of it. An
        // empty string fails both in confusing ways; say what happened instead.
        stubFetch({ choices: [{ message: { content: '' } }] });
        await assert.rejects(
            () => new OpenAiProvider({ apiKey: 'k', defaultMaxTokens: 100, variant: 'openai' })
                .chat({ messages: [user('hi')] }),
            /no message content/,
        );
    });

    test('an HTTP error quotes the provider\'s explanation', async () => {
        stubFetch({}, { status: 429, text: '{"error":{"message":"rate limit reached"}}' });
        await assert.rejects(
            () => new OpenAiProvider({ apiKey: 'k', defaultMaxTokens: 100, variant: 'openai' })
                .chat({ messages: [user('hi')] }),
            /429.*rate limit reached/s,
        );
    });

    // ─── Gemini ─────────────────────────────────────────────────

    test('Gemini renames the assistant role to model', async () => {
        // Gemini rejects `assistant` outright, which breaks the evaluator's
        // multi-turn exploration and nothing else — so it would surface as
        // "evaluation is broken on Gemini only".
        const seen = stubFetch(GEMINI_REPLY);
        await new GeminiProvider({ apiKey: 'k', defaultMaxTokens: 100 }).chat({
            system: 'be careful',
            messages: [user('first'), assistant('READ_FILES: a.ts'), user('here it is')],
        });

        const contents = seen[0].body.contents as Array<{ role: string; parts: [{ text: string }] }>;
        assert.deepStrictEqual(contents.map((c) => c.role), ['user', 'model', 'user']);
        assert.strictEqual(contents[1].parts[0].text, 'READ_FILES: a.ts');
    });

    test('Gemini puts the system prompt in systemInstruction and the key in a header', async () => {
        const seen = stubFetch(GEMINI_REPLY);
        await new GeminiProvider({ apiKey: 'secret-key', defaultMaxTokens: 100 })
            .chat({ system: 'be careful', messages: [user('hi')] });

        assert.deepStrictEqual(seen[0].body.systemInstruction, { parts: [{ text: 'be careful' }] });
        assert.strictEqual(seen[0].headers['x-goog-api-key'], 'secret-key');
        assert.ok(!seen[0].url.includes('secret-key'), 'key must not travel in the URL');
    });

    test('Gemini reports a blocked prompt rather than returning nothing', async () => {
        stubFetch({ promptFeedback: { blockReason: 'SAFETY' } });
        await assert.rejects(
            () => new GeminiProvider({ apiKey: 'k', defaultMaxTokens: 100 })
                .chat({ messages: [user('hi')] }),
            /blocked the prompt \(SAFETY\)/,
        );
    });

    test('Gemini joins multi-part replies', async () => {
        stubFetch({ candidates: [{ content: { parts: [{ text: 'one ' }, { text: 'two' }] } }] });
        const text = await new GeminiProvider({ apiKey: 'k', defaultMaxTokens: 100 })
            .chat({ messages: [user('hi')] });
        assert.strictEqual(text, 'one two');
    });

    // ─── Ollama ─────────────────────────────────────────────────

    test('Ollama sends the system prompt as a system turn and caps with num_predict', async () => {
        const seen = stubFetch(OLLAMA_REPLY);
        await new OllamaProvider({ defaultMaxTokens: 2048 })
            .chat({ system: 'be careful', messages: [user('hi')] });

        assert.strictEqual(seen[0].url, 'http://localhost:11434/api/chat');
        assert.deepStrictEqual(seen[0].body.messages, [
            { role: 'system', content: 'be careful' },
            { role: 'user', content: 'hi' },
        ]);
        assert.deepStrictEqual(seen[0].body.options, { num_predict: 2048 });
        assert.strictEqual(seen[0].body.stream, false);
    });

    test('Ollama surfaces an error returned with a 200', async () => {
        // Ollama answers 200 with an `error` body for an unpulled model, so a
        // successful status is not proof of a successful generation.
        stubFetch({ error: 'model "llama3.1" not found, try pulling it first' });
        await assert.rejects(
            () => new OllamaProvider({ defaultMaxTokens: 100 }).chat({ messages: [user('hi')] }),
            /not found, try pulling it first/,
        );
    });

    // ─── Labels ─────────────────────────────────────────────────

    test('labels name the provider and model without leaking the key', () => {
        const providers = [
            new OpenAiProvider({ apiKey: 'sk-secret', model: 'gpt-4o', defaultMaxTokens: 1, variant: 'openai' }),
            new GeminiProvider({ apiKey: 'sk-secret', model: 'gemini-2.0-flash', defaultMaxTokens: 1 }),
            new OllamaProvider({ model: 'llama3.1', defaultMaxTokens: 1 }),
        ];
        for (const provider of providers) {
            assert.ok(provider.label.includes(provider.id), provider.label);
            assert.ok(!provider.label.includes('sk-secret'), provider.label);
        }
    });

    // ─── Model discovery ────────────────────────────────────────

    test('OpenAI hides models that cannot hold a conversation', async () => {
        // The hosted catalogue mixes embeddings, audio and image models into
        // the same route. Offering `text-embedding-3-large` as a chat model
        // produces a baffling 400 on the first real issue.
        stubFetch({
            data: [
                { id: 'gpt-4o' },
                { id: 'text-embedding-3-large' },
                { id: 'whisper-1' },
                { id: 'tts-1-hd' },
                { id: 'dall-e-3' },
                { id: 'omni-moderation-latest' },
                { id: 'o3-mini' },
            ],
        });

        const models = await new OpenAiProvider({
            apiKey: 'k', defaultMaxTokens: 1, variant: 'openai',
        }).listModels();

        assert.deepStrictEqual(models.map((m) => m.id), ['gpt-4o', 'o3-mini']);
    });

    test('a custom endpoint is listed unfiltered', async () => {
        // A self-hosted server may serve one model under a name that looks
        // nothing like OpenAI's. Hiding the only option is worse than showing
        // an odd one.
        stubFetch({ data: [{ id: 'my-finetune-embedding-v2' }, { id: 'local-llama' }] });

        const models = await new OpenAiProvider({
            apiKey: '', baseUrl: 'http://localhost:8000/v1',
            defaultMaxTokens: 1, variant: 'openai-compatible',
        }).listModels();

        assert.deepStrictEqual(models.map((m) => m.id), ['local-llama', 'my-finetune-embedding-v2']);
    });

    test('OpenAI discovery hits /models on the configured base URL', async () => {
        const seen = stubFetch({ data: [{ id: 'gpt-4o' }] });
        await new OpenAiProvider({
            apiKey: 'k', defaultMaxTokens: 1, variant: 'openai',
        }).listModels();
        assert.strictEqual(seen[0].url, 'https://api.openai.com/v1/models');
    });

    test('Gemini keeps only models that support generateContent', async () => {
        // Gemini declares capability explicitly, so this filters on the
        // declaration rather than guessing from the name as OpenAI requires.
        stubFetch({
            models: [
                {
                    name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash',
                    inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'],
                },
                {
                    name: 'models/text-embedding-004', displayName: 'Embedding',
                    supportedGenerationMethods: ['embedContent'],
                },
                { name: 'models/no-methods-declared' },
            ],
        });

        const models = await new GeminiProvider({ apiKey: 'k', defaultMaxTokens: 1 }).listModels();

        assert.strictEqual(models.length, 1);
        assert.strictEqual(models[0].id, 'gemini-2.0-flash', 'the models/ prefix must be stripped');
        assert.strictEqual(models[0].label, 'Gemini 2.0 Flash');
        assert.strictEqual(models[0].detail, '1M context');
    });

    test('Ollama lists pulled models with size and quantization', async () => {
        stubFetch({
            models: [
                { name: 'qwen2.5:14b', details: { parameter_size: '14.8B', quantization_level: 'Q4_K_M' } },
                { name: 'llama3.1:8b', details: { parameter_size: '8.0B', quantization_level: 'Q4_0' } },
            ],
        });

        const models = await new OllamaProvider({ defaultMaxTokens: 1 }).listModels();

        assert.deepStrictEqual(models.map((m) => m.id), ['llama3.1:8b', 'qwen2.5:14b']);
        assert.strictEqual(models[0].detail, '8.0B · Q4_0');
    });

    test('discovery tolerates a malformed catalogue instead of throwing', async () => {
        // Setup falls back to a text box on an empty list, but only if a junk
        // payload returns empty rather than blowing up mid-quick-pick.
        stubFetch({ data: [{ notAnId: true }, { id: '' }, {}] });
        const models = await new OpenAiProvider({
            apiKey: 'k', defaultMaxTokens: 1, variant: 'openai',
        }).listModels();
        assert.deepStrictEqual(models, []);
    });

    test('context windows render the way model docs write them', () => {
        assert.strictEqual(formatContext(200_000), '200K context');
        assert.strictEqual(formatContext(1_000_000), '1M context');
        // Vendors report powers of two, not round decimals — this is the case
        // that made an integer check render the common limit as "1.0M".
        assert.strictEqual(formatContext(1_048_576), '1M context');
        assert.strictEqual(formatContext(1_500_000), '1.5M context');
        assert.strictEqual(formatContext(0), undefined);
        assert.strictEqual(formatContext(null), undefined);
    });
});
