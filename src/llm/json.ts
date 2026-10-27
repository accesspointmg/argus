// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Pulling a JSON object out of a model reply.
 *
 * Models wrap JSON in prose and code fences, and Argus asks them to read
 * attacker-supplied text, so a reply can also contain braces the attacker
 * planted. A greedy `/\{[\s\S]*\}/` spans from the first `{` to the last `}`,
 * which merges an injected object with the real one or fails outright. This
 * scans for balanced objects instead, skipping braces inside JSON strings, and
 * takes the first one that parses.
 */

export type ModelOutputFailure = 'no-json' | 'canary-missing';

/**
 * The reply could not be used. Deliberately carries no excerpt of the reply:
 * error messages end up in logs and issue comments, and the text may be hostile.
 */
export class ModelOutputError extends Error {
    constructor(message: string, readonly reason: ModelOutputFailure) {
        super(message);
        this.name = 'ModelOutputError';
    }
}

export interface ParseModelJsonOptions {
    /** A token the prompt asked the model to echo. Missing means the reply is not trusted. */
    canary?: string;
}

/**
 * Parse the first top-level JSON object in `text`.
 *
 * Tolerates leading prose and ```json fences. Returns a plain object (never an
 * array or primitive); the caller still has to validate its shape.
 *
 * @throws {ModelOutputError} no parseable object, or `canary` absent from `text`.
 */
export function parseModelJson<T>(text: string, opts: ParseModelJsonOptions = {}): T {
    if (typeof text !== 'string' || text.length === 0) {
        throw new ModelOutputError('Model returned an empty reply', 'no-json');
    }
    if (opts.canary !== undefined && !text.includes(opts.canary)) {
        throw new ModelOutputError('Model reply is missing the expected canary', 'canary-missing');
    }

    let from = 0;
    let sawObject = false;
    while (from < text.length) {
        const start = text.indexOf('{', from);
        if (start < 0) { break; }

        const end = findObjectEnd(text, start);
        if (end < 0) {
            // Unbalanced from here — perhaps a stray brace in prose. Try the next one.
            from = start + 1;
            continue;
        }

        try {
            const value: unknown = JSON.parse(text.slice(start, end + 1));
            if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                // With a canary, only the object carrying it counts: a reply that quotes an
                // attacker-planted object before the real answer must not return the plant.
                if (opts.canary === undefined || (value as { canary?: unknown }).canary === opts.canary) {
                    return value as T;
                }
                sawObject = true;
            }
        } catch {
            // Balanced but not JSON (`{like this}` in prose).
        }
        // Skip the whole span, not into it: a broken outer object must not
        // yield one of its nested objects as if it were the answer.
        from = end + 1;
    }

    if (sawObject) {
        throw new ModelOutputError('No JSON object in the reply carries the expected canary', 'canary-missing');
    }
    throw new ModelOutputError('Model reply contains no valid JSON object', 'no-json');
}

/** Index of the `}` balancing the `{` at `start`, or -1. String-aware. */
function findObjectEnd(text: string, start: number): number {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (ch === '\\') { i++; } else if (ch === '"') { inString = false; }
            continue;
        }
        if (ch === '"') {
            inString = true;
        } else if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) { return i; }
        }
    }
    return -1;
}
