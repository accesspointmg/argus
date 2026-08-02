// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Tests for EngagementPolicy — the bound on how much Argus says.
 *
 * The regression these guard against: the previous rule re-engaged whenever
 * somebody else commented last, so Argus and another agent alternated with no
 * upper bound. `refuses to trade comments with another agent` is the test that
 * would have caught it.
 */

import * as assert from 'assert';
import { EngagementPolicy } from '../../agent/engagement';
import type { Comment } from '../../forge/types';

/** Minimal StampManager stand-in: a stamp is the literal marker `[[stamp:<id>]]`. */
function fakeStamps(ourInstanceId: string) {
    return {
        instanceId: ourInstanceId,
        hasStamp: (body: string) => /\[\[stamp:[a-z0-9]+\]\]/i.test(body),
        extractInstanceId: (body: string) => {
            const m = /\[\[stamp:([a-z0-9]+)\]\]/i.exec(body);
            return m ? m[1] : null;
        },
    } as never;
}

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

let clock = 0;
function comment(author: string, body: string): Comment {
    clock += 1000;
    return {
        id: `c${clock}`,
        body,
        author,
        authorAssociation: 'NONE',
        url: '',
        createdAt: new Date(clock),
        updatedAt: new Date(clock),
        issueNumber: 1,
    };
}

/** A comment from us carries our stamp marker. */
function ours(body = 'assessment') {
    return comment('argus-app[bot]', `${body}\n\n---\n[[stamp:abcd1234]]`);
}

function policy(maxComments = 3) {
    return new EngagementPolicy(fakeStamps('abcd1234'), logger, { maxComments });
}

suite('EngagementPolicy', () => {
    setup(() => { clock = 0; });

    test('engages on a thread with no comments', () => {
        const d = policy().decide([]);
        assert.strictEqual(d.engage, true);
    });

    test('stays quiet when our comment is the most recent', () => {
        const d = policy().decide([comment('alice', 'please look'), ours()]);
        assert.strictEqual(d.engage, false);
        assert.match(d.reason, /most recent/);
    });

    test('engages when a human replies after us', () => {
        const d = policy().decide([ours(), comment('alice', 'what about X?')]);
        assert.strictEqual(d.engage, true);
    });

    test('refuses to trade comments with another agent', () => {
        // The old rule looped here forever: bot spoke last, so Argus replied,
        // which made Argus last, which re-armed the bot, and so on.
        const thread = [
            comment('alice', 'found a bug'),
            ours('my assessment'),
            comment('copilot[bot]', 'I reviewed this'),
        ];

        // First bot comment earns exactly one reply.
        assert.strictEqual(policy().decide(thread).engage, true);

        // After we have answered a bot once, further bot comments get nothing.
        thread.push(ours('acknowledged'));
        thread.push(comment('copilot[bot]', 'I reviewed this again'));
        const d = policy().decide(thread);
        assert.strictEqual(d.engage, false);
        assert.match(d.reason, /not replying to bots again/);
    });

    test('treats a different Argus instance as an agent', () => {
        const other = comment('other-argus[bot]', 'hello\n\n---\n[[stamp:99999999]]');
        const thread = [comment('alice', 'hi'), ours(), other, ours('replied'), other];
        assert.strictEqual(policy().decide(thread).engage, false);
    });

    test('goes quiet once the budget is spent', () => {
        const thread = [
            comment('alice', 'one'), ours('a'),
            comment('alice', 'two'), ours('b'),
            comment('alice', 'three'), ours('c'),
            comment('alice', 'four'),
        ];
        const d = policy(3).decide(thread);
        assert.strictEqual(d.engage, false);
        assert.strictEqual(d.ourComments, 3);
        assert.match(d.reason, /budget spent/);
    });

    test('a human mention overrides a spent budget', () => {
        const thread = [
            ours('a'), ours('b'), ours('c'),
            comment('alice', 'hey @argus can you re-check?'),
        ];
        const d = policy(3).decide(thread);
        assert.strictEqual(d.engage, true);
        assert.match(d.reason, /mentioned by a human/);
    });

    test('a bot cannot summon us past the budget', () => {
        // Otherwise another agent could spend our budget on our behalf.
        const thread = [
            ours('a'), ours('b'), ours('c'),
            comment('copilot[bot]', '@argus please look again'),
        ];
        assert.strictEqual(policy(3).decide(thread).engage, false);
    });

    test('suppresses a comment repeating what we already said', () => {
        const p = policy();
        const thread = [ours('This changes the build script and needs review.')];
        assert.strictEqual(
            p.isDuplicate('This changes the build script and needs review.', thread),
            true,
        );
        assert.strictEqual(p.isDuplicate('Something genuinely new.', thread), false);
    });

    test('duplicate detection ignores stamps and whitespace', () => {
        // Stamps carry a fresh nonce and timestamp every time, so hashing the
        // raw body would never match.
        const p = policy();
        const thread = [ours('same   text')];
        assert.strictEqual(p.isDuplicate('Same text', thread), true);
    });
});
