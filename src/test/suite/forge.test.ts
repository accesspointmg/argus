// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Tests for the guarded forge (the one place dry run, emergency stop, redaction
 * and write budgets are enforced) and the pure forge helpers.
 *
 * The failure these guard against is silent: a write that slips past dry run or
 * a halt looks exactly like normal operation until it's on a public repo.
 */

import * as assert from 'assert';
import type { Forge } from '../../forge/types';
import {
    GuardedForge,
    GuardedForgeOptions,
    HaltedError,
    ForgeRateLimitError,
    HourlyWriteLimiter,
    WriteKind,
} from '../../forge/guarded';
import { referencesIssue, isIssueBranch, hasDraftTitle, countDiffLines, stripScopeQualifiers, baseUrlForHost } from '../../forge/util';
import { mapPipelineStatus } from '../../forge/gitlab';

interface Call { method: string; args: unknown[] }

/** A Forge whose every method records its call and returns a canned value. */
function fakeForge(calls: Call[]): Forge {
    const returns: Record<string, unknown> = {
        addComment: { id: 'real-1' },
        addPRComment: { id: 'real-2' },
        createPullRequest: { number: 7 },
        commitFiles: 'abc123',
        getDefaultBranch: 'main',
        branchExists: true,
    };
    const base = { platform: 'github', owner: 'o', repo: 'r' };
    return new Proxy(base, {
        get(target, prop: string) {
            if (prop in target) { return (target as Record<string, unknown>)[prop]; }
            return async (...args: unknown[]) => {
                calls.push({ method: prop, args });
                return returns[prop];
            };
        },
    }) as unknown as Forge;
}

function makeGuard(overrides: Partial<GuardedForgeOptions> = {}) {
    const calls: Call[] = [];
    const logs: string[] = [];
    const audits: { action: string; details: Record<string, unknown> }[] = [];
    const taken: WriteKind[] = [];
    const state = { dryRun: false, halted: false };
    const opts: GuardedForgeOptions = {
        isDryRun: () => state.dryRun,
        isHalted: () => state.halted,
        redact: (t) => t.replace(/SECRET/g, '[REDACTED]'),
        limiter: { take: (k) => { taken.push(k); } },
        logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
        audit: (action, details) => audits.push({ action, details }),
        ...overrides,
    };
    const guard = new GuardedForge(fakeForge(calls), opts);
    return { guard, calls, logs, audits, taken, state };
}

/** Every write method, with arguments and the limiter kind it must charge. */
const WRITES: { method: keyof Forge; args: unknown[]; kind: WriteKind }[] = [
    { method: 'addComment', args: [1, 'b'], kind: 'comment' },
    { method: 'addPRComment', args: [1, 'b'], kind: 'comment' },
    { method: 'updatePRBody', args: [1, 'b'], kind: 'comment' },
    { method: 'updateIssue', args: [1, { body: 'b' }], kind: 'comment' },
    { method: 'createBranch', args: ['main', 'x'], kind: 'branch' },
    { method: 'createPullRequest', args: ['x', 'main', 't', 'b'], kind: 'pr' },
    { method: 'createOrUpdateFile', args: ['x', 'a.txt', 'c', 'm'], kind: 'push' },
    { method: 'commitFiles', args: ['x', [{ path: 'a', content: 'c' }], 'm'], kind: 'push' },
    { method: 'blockUser', args: ['u'], kind: 'block' },
    { method: 'unblockUser', args: ['u'], kind: 'block' },
    { method: 'reportUser', args: ['u', 'r'], kind: 'block' },
    { method: 'createCommitStatus', args: ['sha', 'success', 'ctx', 'd'], kind: 'status' },
    { method: 'addLabel', args: [1, 'l'], kind: 'label' },
    { method: 'removeLabel', args: [1, 'l'], kind: 'label' },
    { method: 'deleteComment', args: ['1'], kind: 'delete' },
];

function invoke(guard: Forge, method: keyof Forge, args: unknown[]): Promise<unknown> {
    return (guard[method] as (...a: unknown[]) => Promise<unknown>)(...args);
}

suite('GuardedForge', () => {
    test('reads pass straight through, even when halted or in dry run', async () => {
        const { guard, calls, state } = makeGuard();
        state.halted = true;
        state.dryRun = true;
        assert.strictEqual(await guard.getDefaultBranch(), 'main');
        assert.strictEqual(await guard.branchExists('x'), true);
        assert.deepStrictEqual(calls.map((c) => c.method), ['getDefaultBranch', 'branchExists']);
        assert.strictEqual(guard.platform, 'github');
        assert.strictEqual(guard.owner, 'o');
    });

    test('each write charges the right limiter kind and reaches the inner forge', async () => {
        for (const w of WRITES) {
            const { guard, calls, taken } = makeGuard();
            await invoke(guard, w.method, w.args);
            assert.deepStrictEqual(taken, [w.kind], `${w.method} should charge ${w.kind}`);
            assert.deepStrictEqual(calls.map((c) => c.method), [w.method]);
        }
    });

    test('halted: every write throws HaltedError and nothing is sent or charged', async () => {
        for (const w of WRITES) {
            const { guard, calls, taken, state } = makeGuard();
            state.halted = true;
            await assert.rejects(invoke(guard, w.method, w.args), HaltedError, w.method);
            assert.strictEqual(calls.length, 0, `${w.method} reached the forge while halted`);
            assert.strictEqual(taken.length, 0);
        }
    });

    test('halt wins over dry run', async () => {
        const { guard, state } = makeGuard();
        state.halted = true;
        state.dryRun = true;
        await assert.rejects(guard.addComment(1, 'x'), HaltedError);
    });

    test('dry run: every write is a logged no-op that charges nothing', async () => {
        for (const w of WRITES) {
            const { guard, calls, taken, logs, state } = makeGuard();
            state.dryRun = true;
            await invoke(guard, w.method, w.args);
            assert.strictEqual(calls.length, 0, `${w.method} reached the forge in dry run`);
            assert.strictEqual(taken.length, 0);
            assert.ok(logs.some((l) => l.startsWith('[DRY RUN] would ')), `${w.method} did not log`);
        }
    });

    test('dry run returns recognisable stubs', async () => {
        const { guard, state } = makeGuard();
        state.dryRun = true;
        const c1 = await guard.addComment(5, 'hello');
        const c2 = await guard.addPRComment(6, 'hi');
        assert.strictEqual(c1.id, 'dry-run-1');
        assert.strictEqual(c1.issueNumber, 5);
        assert.strictEqual(c2.id, 'dry-run-2');
        const pr = await guard.createPullRequest('h', 'main', 't', 'b');
        assert.strictEqual(pr.number, 0);
        assert.strictEqual(pr.head, 'h');
        assert.match(await guard.commitFiles('h', [], 'm'), /^dry-run-/);
    });

    test('dry run is read at call time, not construction time', async () => {
        const { guard, calls, state } = makeGuard();
        state.dryRun = true;
        await guard.addComment(1, 'a');
        state.dryRun = false;
        await guard.addComment(1, 'b');
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].args[1], 'b');
    });

    test('outbound text is redacted before it leaves', async () => {
        const { guard, calls } = makeGuard();
        await guard.addComment(1, 'key SECRET');
        await guard.addPRComment(1, 'SECRET');
        await guard.updatePRBody(1, 'SECRET');
        await guard.updateIssue(1, { title: 'SECRET t', body: 'SECRET b' });
        await guard.createPullRequest('h', 'main', 'SECRET', 'SECRET body');
        await guard.commitFiles('h', [{ path: 'a', content: 'x=SECRET' }, { path: 'd', content: null }], 'msg SECRET');
        await guard.createOrUpdateFile('h', 'a', 'SECRET', 'SECRET');
        await guard.createCommitStatus('sha', 'failure', 'ctx', 'SECRET');
        await guard.reportUser('u', 'SECRET');
        const sent = JSON.stringify(calls.map((c) => c.args));
        assert.ok(!sent.includes('SECRET'), `unredacted text sent: ${sent}`);
        // Deletions stay deletions.
        const commit = calls.find((c) => c.method === 'commitFiles')!;
        assert.deepStrictEqual(commit.args[1], [{ path: 'a', content: 'x=[REDACTED]' }, { path: 'd', content: null }]);
        // Absent updateIssue fields stay absent.
        const { guard: g2, calls: c2 } = makeGuard();
        await g2.updateIssue(1, { body: 'x' });
        assert.deepStrictEqual(c2[0].args[1], { body: 'x' });
    });

    test('redaction runs before the limiter is charged', async () => {
        const order: string[] = [];
        const { guard } = makeGuard({
            redact: (t) => { order.push('redact'); return t; },
            limiter: { take: () => { order.push('take'); } },
        });
        await guard.addComment(1, 'x');
        assert.deepStrictEqual(order, ['redact', 'take']);
    });

    test('an exhausted limiter blocks the write', async () => {
        const limiter = new HourlyWriteLimiter({ comment: { limit: 1, windowMs: 3_600_000 } });
        const { guard, calls, audits } = makeGuard({ limiter });
        await guard.addComment(1, 'a');
        await assert.rejects(guard.addComment(1, 'b'), ForgeRateLimitError);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(audits[audits.length - 1].details.outcome, 'rate-limited');
        // Other kinds have their own budget.
        await guard.addLabel(1, 'x');
    });

    test('audit records the outcome without message bodies', async () => {
        const { guard, audits, state } = makeGuard();
        await guard.addComment(3, 'private text');
        state.dryRun = true;
        await guard.addComment(3, 'more');
        assert.deepStrictEqual(audits.map((a) => [a.action, a.details.outcome]), [['addComment', 'done'], ['addComment', 'dry-run']]);
        assert.ok(!JSON.stringify(audits).includes('private text'));
    });

    test('inner failures propagate and are audited', async () => {
        const calls: Call[] = [];
        const inner = fakeForge(calls);
        (inner as unknown as Record<string, unknown>).deleteComment = async () => { throw new Error('boom'); };
        const audits: Record<string, unknown>[] = [];
        const guard = new GuardedForge(inner, {
            isDryRun: () => false, isHalted: () => false, redact: (t) => t,
            logger: { info: () => undefined, warn: () => undefined },
            audit: (_a, d) => audits.push(d),
        });
        await assert.rejects(guard.deleteComment('1'), /boom/);
        assert.strictEqual(audits[0].outcome, 'failed');
    });
});

suite('HourlyWriteLimiter', () => {
    const HOUR = 3_600_000;

    test('allows up to the limit, then refuses with a readable message', () => {
        const lim = new HourlyWriteLimiter({ pr: { limit: 2, windowMs: HOUR, setting: 'argus.rateLimits.prsPerHour' } }, () => 0);
        lim.take('pr');
        lim.take('pr');
        try {
            lim.take('pr');
            assert.fail('expected refusal');
        } catch (err) {
            assert.ok(err instanceof ForgeRateLimitError);
            assert.strictEqual(err.kind, 'pr');
            assert.match(err.message, /2 pr write\(s\) per hour/);
            assert.match(err.message, /argus\.rateLimits\.prsPerHour/);
            assert.strictEqual(err.retryAfterMs, HOUR);
        }
    });

    test('the window slides: old writes age out one by one', () => {
        let now = 0;
        const lim = new HourlyWriteLimiter({ comment: { limit: 2, windowMs: HOUR } }, () => now);
        lim.take('comment');          // t=0
        now = 10 * 60_000;
        lim.take('comment');          // t=10m
        now = 59 * 60_000;
        assert.throws(() => lim.take('comment'), ForgeRateLimitError);
        now = HOUR + 1;               // first write aged out
        lim.take('comment');
        assert.throws(() => lim.take('comment'), ForgeRateLimitError);
        assert.strictEqual(lim.remaining('comment'), 0);
    });

    test('kinds are budgeted independently; unconfigured kinds are unlimited', () => {
        const lim = new HourlyWriteLimiter({ branch: { limit: 1, windowMs: HOUR } }, () => 0);
        lim.take('branch');
        assert.throws(() => lim.take('branch'), ForgeRateLimitError);
        for (let i = 0; i < 100; i++) { lim.take('status'); }
        assert.strictEqual(lim.remaining('status'), Infinity);
    });

    test('a limit of zero (or garbage) allows nothing — never unlimited', () => {
        const lim = new HourlyWriteLimiter({
            block: { limit: 0, windowMs: 86_400_000 },
            delete: { limit: NaN, windowMs: HOUR },
            push: { limit: -5, windowMs: HOUR },
        }, () => 0);
        assert.throws(() => lim.take('block'), ForgeRateLimitError);
        assert.throws(() => lim.take('delete'), ForgeRateLimitError);
        assert.throws(() => lim.take('push'), ForgeRateLimitError);
    });

    test('reconfiguring keeps history, so it never refills the budget', () => {
        const lim = new HourlyWriteLimiter({ pr: { limit: 1, windowMs: HOUR } }, () => 0);
        lim.take('pr');
        lim.configure({ pr: { limit: 1, windowMs: HOUR } });
        assert.throws(() => lim.take('pr'), ForgeRateLimitError);
        lim.configure({ pr: { limit: 2, windowMs: HOUR } });
        lim.take('pr');
    });
});

suite('forge helpers', () => {
    test('issue references match #N as a whole token only', () => {
        assert.ok(referencesIssue('Fixes #1', 1));
        assert.ok(referencesIssue('closes #12.', 12));
        assert.ok(referencesIssue('(#7)', 7));
        assert.ok(referencesIssue('#3', 3));
        assert.ok(!referencesIssue('Fixes #12', 1));
        assert.ok(!referencesIssue('see #100', 1));
        assert.ok(!referencesIssue('other/repo#1', 1));
        assert.ok(!referencesIssue('abc#1', 1));
        assert.ok(!referencesIssue('#1a', 1));
    });

    test('issue branches match the issue number exactly', () => {
        assert.ok(isIssueBranch('ai-fix/issue-12', 12));
        assert.ok(isIssueBranch('issue-12', 12));
        assert.ok(!isIssueBranch('ai-fix/issue-123', 12));
        assert.ok(!isIssueBranch('ai-fix/issue-1', 12));
        assert.ok(!isIssueBranch('ai-fix/myissue-12', 12));
    });

    test('draft titles', () => {
        assert.ok(hasDraftTitle('Draft: thing'));
        assert.ok(hasDraftTitle('WIP: thing'));
        assert.ok(hasDraftTitle('[WIP] thing'));
        assert.ok(!hasDraftTitle('Drafting guide'));
        assert.ok(!hasDraftTitle('Fix wip handling'));
    });

    test('diff line counts skip file headers', () => {
        assert.deepStrictEqual(countDiffLines('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n+c\n ctx'), { additions: 2, deletions: 1 });
        assert.deepStrictEqual(countDiffLines(undefined), { additions: 0, deletions: 0 });
    });

    test('code search cannot be widened to other repos', () => {
        assert.strictEqual(stripScopeQualifiers('token repo:evil/x org:evil user:me foo'), 'token foo');
    });

    test('host → base URL', () => {
        assert.strictEqual(baseUrlForHost('github', undefined), undefined);
        assert.strictEqual(baseUrlForHost('github', 'github.com'), undefined);
        assert.strictEqual(baseUrlForHost('github', 'ghe.corp.example'), 'https://ghe.corp.example/api/v3');
        assert.strictEqual(baseUrlForHost('gitlab', 'gitlab.com'), undefined);
        assert.strictEqual(baseUrlForHost('gitlab', 'https://git.example.com/gitlab/'), 'https://git.example.com/gitlab');
        assert.strictEqual(baseUrlForHost('gitlab', 'git.example.com:8443'), 'https://git.example.com:8443');
        assert.throws(() => baseUrlForHost('gitlab', 'http://git.example.com'), /https/);
        assert.throws(() => baseUrlForHost('gitlab', 'evil.com?x=@good.com'), /Invalid/);
    });

    test('unfinished GitLab pipelines never read as passing', () => {
        for (const s of ['created', 'waiting_for_resource', 'preparing', 'pending', 'scheduled']) {
            assert.deepStrictEqual(mapPipelineStatus(s), { status: 'queued', conclusion: null }, s);
        }
        assert.deepStrictEqual(mapPipelineStatus('running'), { status: 'in_progress', conclusion: null });
        assert.strictEqual(mapPipelineStatus('manual').conclusion, 'action_required');
        assert.strictEqual(mapPipelineStatus('skipped').conclusion, 'neutral');
        assert.strictEqual(mapPipelineStatus('canceled').conclusion, 'cancelled');
        assert.strictEqual(mapPipelineStatus('failed').conclusion, 'failure');
        assert.strictEqual(mapPipelineStatus('success').conclusion, 'success');
        assert.notStrictEqual(mapPipelineStatus('some_new_status').conclusion, 'success');
    });
});
