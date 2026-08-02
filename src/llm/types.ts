// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * The model-facing surface Argus depends on.
 *
 * Argus used to call `vscode.lm.selectChatModels({ vendor: 'copilot' })` in five
 * places, which made a GitHub Copilot subscription a hard requirement for a tool
 * whose whole job is reviewing other people's code. Nothing about that job needs
 * Copilot specifically, so the dependency is expressed here as an interface
 * instead: whatever can turn a conversation into text will do.
 *
 * The interface is deliberately small. Argus asks a model to read some text and
 * reply with JSON — no tool calls, no images, no streaming to a UI. Providers
 * that support more are free to; nothing here needs it. Keeping the surface
 * narrow is what makes a local Ollama model and the Anthropic API interchangeable
 * from the call sites' point of view.
 */

import type * as vscode from 'vscode';

// ─── Conversations ──────────────────────────────────────────────

/**
 * Roles Argus actually uses.
 *
 * There is no `system` role here — a system prompt is a property of the request
 * (see {@link ChatRequest.system}), not a turn in the conversation. Providers
 * disagree about how to carry one: the Anthropic API has a dedicated `system`
 * parameter, the VS Code LM API has no such concept at all. Modeling it as a
 * request field lets each provider do the right thing.
 */
export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
    role: ChatRole;
    text: string;
}

export interface ChatRequest {
    /**
     * Instructions framing the task, kept apart from the conversation.
     *
     * Providers with a real system channel use it, which matters for a security
     * tool: content lifted from an untrusted issue arrives in a `user` message,
     * so keeping our own instructions out of that channel makes them harder to
     * impersonate. Providers without one prepend it as the first user turn,
     * which is exactly what the old Copilot-only code did.
     */
    system?: string;
    /** The conversation so far. Must be non-empty and should start with a user turn. */
    messages: ChatMessage[];
    /** Ceiling on the reply. Providers fall back to the configured default. */
    maxTokens?: number;
    /** Aborts the request when cancelled. */
    token?: vscode.CancellationToken;
}

// ─── Providers ──────────────────────────────────────────────────

export type ProviderId =
    | 'vscode-lm'
    | 'anthropic'
    | 'openai'
    | 'openai-compatible'
    | 'gemini'
    | 'ollama';

export const PROVIDER_IDS: readonly ProviderId[] = [
    'vscode-lm',
    'anthropic',
    'openai',
    'openai-compatible',
    'gemini',
    'ollama',
];

/** Providers that authenticate with a key held in SecretStorage. */
export const KEYED_PROVIDERS: readonly ProviderId[] = [
    'anthropic',
    'openai',
    'openai-compatible',
    'gemini',
];

/**
 * How hard the model should think before answering.
 *
 * Argus's calls sit at both ends of this range: classifying a comment for
 * prompt injection is a cheap judgement, while deciding whether a stranger's
 * diff is hostile is not. Leaving this unset uses the provider's own default,
 * which is the right choice until someone has a reason to move it.
 *
 * Currently honored by the Anthropic provider. Others ignore it rather than
 * guessing at an equivalent — sending the wrong knob is a 400, not a shrug.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** One model a provider currently offers, as shown in the setup picker. */
export interface ModelInfo {
    /** Exact string stored in `argus.ai.model` and sent to the provider. */
    id: string;
    /** Human-readable name for the picker. Falls back to the id. */
    label: string;
    /** Secondary line — context window, parameter size, whatever the vendor gives us. */
    detail?: string;
}

export interface LlmProvider {
    readonly id: ProviderId;
    /** Provider and model, for logs and status messages — never a secret. */
    readonly label: string;

    /**
     * Whether this provider could serve a request right now.
     *
     * Two callers depend on an honest answer: `Investigator` and `PRAnalyzer`
     * fall back to heuristics rather than failing when no model is reachable.
     * Implementations should stay cheap — check for a key, not for a heartbeat.
     */
    isAvailable(): Promise<boolean>;

    /** Send a conversation and return the reply's text. */
    chat(request: ChatRequest): Promise<string>;

    /**
     * Models this provider currently offers.
     *
     * Used to populate the picker during setup, so nobody has to type
     * `claude-opus-5` from memory and discover the typo as a 404 on the first
     * real issue. Best-effort by nature: the answer depends on the key, the
     * endpoint and the vendor's catalogue, and a self-hosted server may not
     * implement a listing route at all. Callers must treat a throw or an empty
     * array as "ask the user to type it" rather than as a failure.
     */
    listModels?(): Promise<ModelInfo[]>;
}

// ─── Errors ─────────────────────────────────────────────────────

/**
 * No model could be reached: none configured, no key, or the vendor returned
 * nothing. Distinguished from a transport failure so callers can tell "you
 * haven't set this up" from "the network is down".
 */
export class LlmUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'LlmUnavailableError';
    }
}

/**
 * Argus has made as many model calls this hour as it is allowed.
 *
 * Not a provider error — Argus stopped itself. Carries how long until the next
 * slot so a caller can say something more useful than "try later".
 */
export class LlmRateLimitError extends Error {
    constructor(message: string, readonly retryAfterMs: number) {
        super(message);
        this.name = 'LlmRateLimitError';
    }
}

/**
 * The provider declined the request on policy grounds.
 *
 * Argus asks models to read hostile input on purpose — prompt-injection
 * attempts, exploit code, malware in a pull request. Safety classifiers
 * sometimes decline that, and it is not a bug in Argus. Callers that have a
 * conservative fallback should prefer it over failing the whole pipeline.
 */
export class LlmRefusalError extends Error {
    constructor(message: string, readonly category?: string) {
        super(message);
        this.name = 'LlmRefusalError';
    }
}

// ─── Helpers ────────────────────────────────────────────────────

export function user(text: string): ChatMessage {
    return { role: 'user', text };
}

export function assistant(text: string): ChatMessage {
    return { role: 'assistant', text };
}
