// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Cancellation helpers shared by the pipeline, coder and controller.
 *
 * Long-running work (CI waits, multi-turn model calls) takes an `AbortSignal`
 * so Stop, Emergency Stop and the watchdog can end it promptly instead of
 * letting it finish and push.
 */

export class AbortedError extends Error {
    constructor(reason?: string) {
        super(reason ? `Aborted: ${reason}` : 'Aborted');
        this.name = 'AbortedError';
    }
}

/** Throw {@link AbortedError} if the signal has fired. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw new AbortedError(reasonText(signal));
    }
}

/** Sleep that ends early (rejecting) when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new AbortedError(reasonText(signal)));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(new AbortedError(reasonText(signal)));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * A controller that aborts when any parent signal aborts or after `timeoutMs`.
 * Call `dispose()` when done so the timer and listeners don't leak.
 */
export function linkedController(
    parents: (AbortSignal | undefined)[],
    timeoutMs?: number,
    timeoutReason = 'timed out',
): { controller: AbortController; dispose: () => void } {
    const controller = new AbortController();
    const cleanups: (() => void)[] = [];

    for (const parent of parents) {
        if (!parent) { continue; }
        if (parent.aborted) {
            controller.abort(parent.reason);
            break;
        }
        const onAbort = (): void => controller.abort(parent.reason);
        parent.addEventListener('abort', onAbort, { once: true });
        cleanups.push(() => parent.removeEventListener('abort', onAbort));
    }

    if (timeoutMs && timeoutMs > 0) {
        const timer = setTimeout(() => controller.abort(timeoutReason), timeoutMs);
        cleanups.push(() => clearTimeout(timer));
    }

    return { controller, dispose: () => cleanups.forEach((fn) => fn()) };
}

export function isAbortError(err: unknown): boolean {
    return err instanceof AbortedError || (err instanceof Error && err.name === 'HaltedError');
}

function reasonText(signal?: AbortSignal): string | undefined {
    const r: unknown = signal?.reason;
    if (r === undefined) { return undefined; }
    return r instanceof Error ? r.message : String(r);
}
