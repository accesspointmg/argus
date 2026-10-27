// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Typed forge errors. Callers branch on these with `instanceof`.
 */

/** The operation has no safe equivalent on this forge (e.g. GitLab user blocks). */
export class UnsupportedError extends Error {
    constructor(readonly operation: string, reason: string) {
        super(`${operation} is not supported: ${reason}`);
        this.name = 'UnsupportedError';
    }
}

/** Emergency stop is engaged; no forge writes are allowed. */
export class HaltedError extends Error {
    constructor(action: string) {
        super(`Argus is halted (emergency stop); refused to ${action}`);
        this.name = 'HaltedError';
    }
}

/** Write kinds the limiter budgets separately. */
export type WriteKind = 'comment' | 'branch' | 'pr' | 'push' | 'block' | 'status' | 'label' | 'delete';

/** A local write budget is exhausted. */
export class ForgeRateLimitError extends Error {
    constructor(
        readonly kind: WriteKind,
        readonly limit: number,
        readonly windowMs: number,
        readonly retryAfterMs: number,
        setting?: string,
    ) {
        const window = windowMs === 3_600_000 ? 'hour' : windowMs === 86_400_000 ? 'day' : `${Math.round(windowMs / 1000)}s`;
        const where = setting ? ` (${setting})` : '';
        super(`Forge write limit reached: ${limit} ${kind} write(s) per ${window}${where}; retry in ${Math.ceil(retryAfterMs / 1000)}s`);
        this.name = 'ForgeRateLimitError';
    }
}

/** A forge HTTP call failed. `status` is the HTTP status (0 for network errors). */
export class ForgeHttpError extends Error {
    constructor(readonly status: number, message: string, readonly retryAfterMs?: number) {
        super(message);
        this.name = 'ForgeHttpError';
    }
}

/** Extract an HTTP status from an Octokit/ForgeHttpError-style error, if any. */
export function httpStatus(err: unknown): number | undefined {
    if (err && typeof err === 'object' && 'status' in err) {
        const s = (err as { status: unknown }).status;
        return typeof s === 'number' ? s : undefined;
    }
    return undefined;
}

/** True when the error is a remote rate-limit refusal (429, or GitHub's 403 rate limit). */
export function isRemoteRateLimit(err: unknown): boolean {
    const status = httpStatus(err);
    if (status === 429) { return true; }
    if (status !== 403) { return false; }
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const headers = (err as any)?.response?.headers ?? {};
    return msg.includes('rate limit') || headers['x-ratelimit-remaining'] === '0' || 'retry-after' in headers;
}
