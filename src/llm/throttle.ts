// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * The ceiling on how often Argus may call a model.
 *
 * `argus.rateLimits.llmCallsPerHour` has existed since the first version and
 * has never been enforced — the setting was declared, read by nothing, and
 * quietly implied a cost guarantee Argus did not make. Now that every model
 * call goes through {@link LlmService}, there is one place to put it.
 *
 * The limit matters more than it used to. Under the old Copilot-only design a
 * runaway loop burned someone's subscription quota; with an API key configured
 * it bills a card. The failure this guards against is not malice but a bug —
 * a retry that does not back off, an evaluation that re-explores forever.
 *
 * Exhaustion throws rather than waits. Argus polls on a timer, and blocking a
 * call for the ~36 seconds a single slot takes to accrue (or minutes, at a low
 * limit) would stall the pipeline and its watchdog. Throwing marks that one
 * issue `stuck` with the reason attached; the next poll picks it up again.
 */

import { LlmRateLimitError } from './types';

const SECONDS_PER_HOUR = 3600;

/** Token bucket: `capacity` burst, refilled at `perSecond`. Local so the budget has no outside dependency. */
class Bucket {
    private tokens: number;
    private last = Date.now();

    constructor(private readonly capacity: number, private readonly perSecond: number, initial = capacity) {
        this.tokens = Math.min(capacity, Math.max(0, initial));
    }

    tryConsume(): boolean {
        this.refill();
        if (this.tokens >= 1) {
            this.tokens -= 1;
            return true;
        }
        return false;
    }

    /** Exact (fractional) tokens left. */
    level(): number {
        this.refill();
        return this.tokens;
    }

    private refill(): void {
        const now = Date.now();
        this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.perSecond);
        this.last = now;
    }
}

/**
 * Smallest limit we will honor.
 *
 * Clamping up rather than treating zero as "unlimited": someone lowering this
 * setting is trying to spend less, and the conventional 0-means-no-limit
 * reading would hand them the opposite of what they asked for.
 */
const MIN_CALLS_PER_HOUR = 1;

export class LlmThrottle {
    private limiter: Bucket;
    private callsPerHour: number;

    constructor(callsPerHour: number) {
        this.callsPerHour = LlmThrottle.clamp(callsPerHour);
        this.limiter = LlmThrottle.build(this.callsPerHour);
    }

    /**
     * Adopt a new limit if it changed.
     *
     * Guarded on change, and the spent count carried over, because a rebuilt
     * bucket starts full: rebuilding naively would reset the budget.
     */
    configure(callsPerHour: number): void {
        const next = LlmThrottle.clamp(callsPerHour);
        if (next === this.callsPerHour) {
            return;
        }
        // Carry over what has been spent: a fresh full bucket would let anyone
        // nudge the setting to reset the budget, even while lowering it.
        const used = this.callsPerHour - this.limiter.level();
        this.callsPerHour = next;
        this.limiter = LlmThrottle.build(next, next - used);
    }

    /** Claim one call, or throw {@link LlmRateLimitError} if the budget is spent. */
    claim(): void {
        if (this.limiter.tryConsume()) {
            return;
        }
        const retryAfterMs = Math.ceil((SECONDS_PER_HOUR / this.callsPerHour) * 1000);
        throw new LlmRateLimitError(
            `AI call budget exhausted (${this.callsPerHour}/hour). ` +
            `Next call available in about ${Math.ceil(retryAfterMs / 1000)}s. ` +
            `Raise argus.rateLimits.llmCallsPerHour if this is too tight.`,
            retryAfterMs,
        );
    }

    /** Calls still available right now. For status display and tests. */
    remaining(): number {
        return Math.floor(this.limiter.level());
    }

    /** The limit currently in force, after clamping. */
    get limit(): number {
        return this.callsPerHour;
    }

    private static clamp(callsPerHour: number): number {
        if (!Number.isFinite(callsPerHour)) {
            return MIN_CALLS_PER_HOUR;
        }
        return Math.max(MIN_CALLS_PER_HOUR, Math.floor(callsPerHour));
    }

    /**
     * A token bucket whose capacity is the hourly figure.
     *
     * So a batch of queued issues can be worked through back to back, and only
     * sustained load is held to the average. The cost of that convenience is
     * that a burst plus a full hour of refill can reach roughly twice the
     * nominal rate in one rolling hour — standard for a token bucket, and the
     * reason this is a guard rail rather than a billing guarantee.
     */
    private static build(callsPerHour: number, initial = callsPerHour): Bucket {
        return new Bucket(callsPerHour, callsPerHour / SECONDS_PER_HOUR, initial);
    }
}
