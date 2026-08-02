// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Rate limiter — token-bucket algorithm for API and LLM rate limiting.
 */

export class RateLimiter {
    private tokens: number;
    private lastRefill: number;

    /**
     * @param maxTokens Maximum burst capacity
     * @param refillRate Tokens added per second
     */
    constructor(
        private readonly maxTokens: number,
        private readonly refillRate: number,
    ) {
        this.tokens = maxTokens;
        this.lastRefill = Date.now();
    }

    /**
     * Try to consume a token. Returns true if allowed, false if rate-limited.
     */
    tryConsume(count: number = 1): boolean {
        this.refill();
        if (this.tokens >= count) {
            this.tokens -= count;
            return true;
        }
        return false;
    }

    /**
     * Wait until a token is available, then consume it.
     */
    async consume(count: number = 1): Promise<void> {
        while (!this.tryConsume(count)) {
            const waitMs = Math.ceil((count - this.tokens) / this.refillRate * 1000);
            await new Promise((resolve) => setTimeout(resolve, Math.max(50, waitMs)));
        }
    }

    /**
     * Get remaining tokens.
     */
    remaining(): number {
        this.refill();
        return Math.floor(this.tokens);
    }

    private refill(): void {
        const now = Date.now();
        const elapsed = (now - this.lastRefill) / 1000;
        this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
        this.lastRefill = now;
    }
}
