// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Tests for the hourly model-call budget.
 *
 * The setting this enforces sat unread for the project's whole life, so the
 * first thing worth proving is simply that exhausting it stops a call. After
 * that, the interesting cases are the ones where a limiter quietly enforces
 * nothing: a bucket rebuilt on every request refills every time, and a limit
 * of zero read as "unlimited" hands someone the opposite of what they asked
 * for. Both look fine until the bill arrives.
 */

import * as assert from 'assert';
import { LlmThrottle } from '../../llm/throttle';
import { LlmRateLimitError } from '../../llm/types';

suite('LlmThrottle', () => {
    test('allows calls up to the limit, then refuses', () => {
        const throttle = new LlmThrottle(3);
        for (let i = 0; i < 3; i++) {
            throttle.claim();
        }
        assert.throws(() => throttle.claim(), LlmRateLimitError);
    });

    test('the refusal says what the limit is and when to retry', () => {
        // It surfaces on the issue as `stuck: <message>`, so it has to be
        // readable on its own — nobody will have the logs open.
        const throttle = new LlmThrottle(60);
        throttle.claim();
        try {
            for (let i = 0; i < 60; i++) { throttle.claim(); }
            assert.fail('expected the budget to run out');
        } catch (err) {
            assert.ok(err instanceof LlmRateLimitError);
            assert.match(err.message, /60\/hour/);
            assert.match(err.message, /argus\.rateLimits\.llmCallsPerHour/);
            assert.strictEqual(err.retryAfterMs, 60_000); // 3600s / 60 calls
        }
    });

    test('reconfiguring to the same limit does not refill the bucket', () => {
        // The regression this guards: `configure()` runs on every chat() call,
        // so rebuilding unconditionally would restore the budget each time and
        // the limit would never bind.
        const throttle = new LlmThrottle(2);
        throttle.claim();
        throttle.claim();

        throttle.configure(2);
        throttle.configure(2);

        assert.throws(() => throttle.claim(), LlmRateLimitError);
    });

    test('an actual change to the limit takes effect immediately', () => {
        const throttle = new LlmThrottle(1);
        throttle.claim();
        assert.throws(() => throttle.claim(), LlmRateLimitError);

        throttle.configure(5);
        assert.strictEqual(throttle.limit, 5);
        throttle.claim(); // the raised limit is usable without a reload
    });

    test('a limit of zero or below clamps to one rather than meaning unlimited', () => {
        // Failing in the safe direction: somebody typing a smaller number is
        // trying to spend less, and the usual 0-means-no-limit convention would
        // silently remove the cap they were reaching for.
        for (const bad of [0, -1, -100]) {
            const throttle = new LlmThrottle(bad);
            assert.strictEqual(throttle.limit, 1, `limit ${bad}`);
            throttle.claim();
            assert.throws(() => throttle.claim(), LlmRateLimitError, `limit ${bad}`);
        }
    });

    test('a non-numeric limit clamps rather than disabling the budget', () => {
        // `cfg.get<number>` will hand back whatever is in settings.json.
        const throttle = new LlmThrottle(Number.NaN);
        assert.strictEqual(throttle.limit, 1);
        throttle.claim();
        assert.throws(() => throttle.claim(), LlmRateLimitError);
    });

    test('a fractional limit floors instead of allowing a part-call', () => {
        const throttle = new LlmThrottle(2.9);
        assert.strictEqual(throttle.limit, 2);
        throttle.claim();
        throttle.claim();
        assert.throws(() => throttle.claim(), LlmRateLimitError);
    });

    test('remaining() reports the unspent budget', () => {
        const throttle = new LlmThrottle(10);
        assert.strictEqual(throttle.remaining(), 10);
        throttle.claim();
        throttle.claim();
        assert.strictEqual(throttle.remaining(), 8);
    });
});
