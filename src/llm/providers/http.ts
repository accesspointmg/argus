// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Shared plumbing for the providers that speak plain HTTP.
 *
 * The Anthropic provider does not use this — it goes through the official SDK,
 * which brings its own retries, timeouts and error types. Everything else here
 * (OpenAI and compatible servers, Gemini, Ollama) is a single JSON POST, which
 * is not worth a dependency each.
 */

import type * as vscode from 'vscode';

/** How long to wait before giving up on a provider that has stopped responding. */
const DEFAULT_TIMEOUT_MS = 180_000;

/** How much of an error body to quote back. Enough to diagnose, not enough to flood a log. */
const ERROR_BODY_LIMIT = 500;

/**
 * Bridge a VS Code cancellation token to the `AbortSignal` `fetch` expects, and
 * fold in a wall-clock timeout so a hung provider cannot stall the pipeline
 * forever.
 */
function abortSignalFor(token: vscode.CancellationToken | undefined, timeoutMs: number): {
    signal: AbortSignal;
    dispose: () => void;
} {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const subscription = token?.onCancellationRequested(() => controller.abort());
    if (token?.isCancellationRequested) {
        controller.abort();
    }
    return {
        signal: controller.signal,
        dispose: () => {
            clearTimeout(timer);
            subscription?.dispose();
        },
    };
}

/**
 * POST a JSON body and parse a JSON reply.
 *
 * Throws on any non-2xx, quoting the start of the response body: provider error
 * messages ("model not found", "insufficient quota") are the useful part, and
 * a bare status code sends people hunting for nothing.
 */
export async function postJson<T>(options: {
    url: string;
    body: unknown;
    headers?: Record<string, string>;
    token?: vscode.CancellationToken;
    timeoutMs?: number;
}): Promise<T> {
    const { signal, dispose } = abortSignalFor(
        options.token,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    try {
        const response = await fetch(options.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...options.headers },
            body: JSON.stringify(options.body),
            signal,
        });

        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, ERROR_BODY_LIMIT);
            throw new Error(
                `HTTP ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`,
            );
        }

        return (await response.json()) as T;
    } catch (err) {
        // An abort is either the caller cancelling or our own timeout firing;
        // `fetch` reports both the same way, so say which without pretending to
        // know more than we do.
        if (err instanceof Error && err.name === 'AbortError') {
            throw new Error('Request aborted (cancelled or timed out)');
        }
        throw err;
    } finally {
        dispose();
    }
}

/**
 * GET and parse a JSON reply.
 *
 * Used only for model discovery, so the deadline is short: this runs while a
 * quick-pick is waiting to open, and a provider that cannot answer promptly
 * should fall back to a plain text box rather than hang the setup flow.
 */
export async function getJson<T>(options: {
    url: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
}): Promise<T> {
    const { signal, dispose } = abortSignalFor(undefined, options.timeoutMs ?? 10_000);
    try {
        const response = await fetch(options.url, { headers: options.headers ?? {}, signal });
        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, ERROR_BODY_LIMIT);
            throw new Error(
                `HTTP ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`,
            );
        }
        return (await response.json()) as T;
    } finally {
        dispose();
    }
}

/** Strip a trailing slash so callers can join paths without doubling up. */
export function trimBaseUrl(url: string): string {
    return url.replace(/\/+$/, '');
}

/** Render a token count the way model docs do: 200K, 1M. */
export function formatContext(tokens: number | null | undefined): string | undefined {
    if (!tokens || tokens <= 0) {
        return undefined;
    }
    if (tokens >= 1_000_000) {
        // Real limits are powers of two (Gemini reports 1048576), so an exact
        // integer check would render the common case as "1.0M". Round to one
        // decimal and drop a trailing zero.
        const millions = (tokens / 1_000_000).toFixed(1).replace(/\.0$/, '');
        return `${millions}M context`;
    }
    return `${Math.round(tokens / 1000)}K context`;
}
