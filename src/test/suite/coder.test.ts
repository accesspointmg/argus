// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Coder containment tests with a fake model and a fake forge: nothing outside
 * the investigated files is ever pushed, CI is read for the exact commit, and
 * "no CI" is never reported as passing.
 */

import * as assert from 'assert';
import { Coder } from '../../agent/coder';
import { OutputValidator } from '../../security/validator';
import type { Forge, CheckRun, CommitStatus } from '../../forge/types';
import type { IssueEvaluation, TrackedIssue } from '../../agent/types';
import type { InvestigationResult } from '../../agent/investigator';

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
const stamps = { generate: () => ({ signature: 'f'.repeat(64) }) } as never;
const audit = { append: async () => {} } as never;

/** A model that echoes the canary and returns the given files. */
function fakeLlm(files: Array<{ path: string; content: string | null }>): { llm: never; calls: number } {
    const state = { calls: 0 };
    const llm = {
        async chat(req: { system?: string }) {
            state.calls++;
            const canary = /"canary": "([0-9a-f]+)"/.exec(req.system ?? '')?.[1] ?? '';
            return JSON.stringify({ canary, files, commitMessage: 'fix: thing', reasoning: 'r', selfReview: 's' });
        },
    };
    return { llm: llm as never, get calls() { return state.calls; } } as never;
}

function fakeForge(ci: { checks: CheckRun[]; statuses?: CommitStatus[] }): { forge: Forge; commits: Array<{ files: unknown[]; message: string }> } {
    const commits: Array<{ files: unknown[]; message: string }> = [];
    const forge = {
        platform: 'github', owner: 'o', repo: 'r',
        async commitFiles(_branch: string, files: unknown[], message: string) {
            commits.push({ files, message });
            return `sha${commits.length}`;
        },
        async getCheckRuns() { return ci.checks; },
        async getCommitStatuses() { return ci.statuses ?? []; },
        async getCheckRunLog() { return 'boom'; },
    } as unknown as Forge;
    return { forge, commits };
}

const issue = (): TrackedIssue => ({
    issueNumber: 7, repo: 'github:o/r', title: 't', url: '', state: 'coding',
    createdAt: new Date(), bodyHash: '', currentIteration: 0, maxIterations: 2, branchName: 'ai-fix/issue-7',
});

const evaluation: IssueEvaluation = {
    merit: true, confidence: 0.9, reasoning: '', suggestedLabels: [], affectedFiles: ['src/a.ts'],
    proposedApproach: 'fix a', severity: 'low', category: 'bug',
};

const investigation: InvestigationResult = {
    filesExamined: ['src/a.ts', 'src/big.ts'],
    files: [
        { path: 'src/a.ts', content: 'export const a = 1;\n', complete: true },
        { path: 'src/big.ts', content: 'excerpt', complete: false },
    ],
    dependencies: [],
    suggestedChanges: [{ path: 'src/a.ts', description: 'x', approach: 'modify' }],
    confidence: 0.8,
    notes: '',
};

const options = { maxIterations: 2, maxDiffLines: 50, issueTitle: 't', issueBody: 'b', ciTiming: { pollMs: 1, appearMs: 5, timeoutMs: 200 } };
const passing: CheckRun = { id: '1', name: 'ci', status: 'completed', conclusion: 'success', url: '' };

suite('Coder containment', () => {
    test('commits an allowed change atomically and reports passing CI', async () => {
        const { forge, commits } = fakeForge({ checks: [passing] });
        const coder = new Coder(logger, new OutputValidator(), stamps, audit, fakeLlm([{ path: 'src/a.ts', content: 'export const a = 2;\n' }]).llm);
        const its = await coder.code(forge, issue(), evaluation, investigation, options);
        assert.strictEqual(commits.length, 1);
        assert.strictEqual(its[0].ciResult, 'passing');
        assert.strictEqual(its[0].commitSha, 'sha1');
        assert.ok(commits[0].message.includes('Argus-Issue: #7'));
    });

    test('never pushes files outside the investigated set', async () => {
        const { forge, commits } = fakeForge({ checks: [passing] });
        for (const path of ['src/other.ts', 'src/big.ts', '.github/workflows/ci.yml', 'package.json']) {
            const coder = new Coder(logger, new OutputValidator(), stamps, audit, fakeLlm([{ path, content: 'x' }]).llm);
            const its = await coder.code(forge, issue(), evaluation, investigation, options);
            assert.ok(its.every((it) => !it.commitSha), path);
            assert.ok(its[0].selfReview.startsWith('Blocked'), path);
        }
        assert.strictEqual(commits.length, 0);
    });

    test('rejects path traversal from the model', async () => {
        const { forge, commits } = fakeForge({ checks: [passing] });
        const coder = new Coder(logger, new OutputValidator(), stamps, audit, fakeLlm([{ path: '../../etc/passwd', content: 'x' }]).llm);
        const its = await coder.code(forge, issue(), evaluation, investigation, options);
        assert.strictEqual(commits.length, 0);
        assert.ok(its[0].selfReview.includes('invalid path'));
    });

    test('enforces maxDiffLines before pushing', async () => {
        const { forge, commits } = fakeForge({ checks: [passing] });
        const big = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
        const coder = new Coder(logger, new OutputValidator(), stamps, audit, fakeLlm([{ path: 'src/a.ts', content: big }]).llm);
        await coder.code(forge, issue(), evaluation, investigation, options);
        assert.strictEqual(commits.length, 0);
    });

    test('no CI is reported as "none", not passing', async () => {
        const { forge } = fakeForge({ checks: [] });
        const coder = new Coder(logger, new OutputValidator(), stamps, audit, fakeLlm([{ path: 'src/a.ts', content: 'export const a = 3;\n' }]).llm);
        const its = await coder.code(forge, issue(), evaluation, investigation, options);
        assert.strictEqual(its[0].ciResult, 'none');
    });

    test("Argus's own merge-gate status is not counted as CI", async () => {
        const { forge } = fakeForge({
            checks: [],
            statuses: [{ state: 'pending', context: 'argus/threat-assessment', description: '', url: '' }],
        });
        const coder = new Coder(logger, new OutputValidator(), stamps, audit, fakeLlm([{ path: 'src/a.ts', content: 'export const a = 4;\n' }]).llm);
        const its = await coder.code(forge, issue(), evaluation, investigation, options);
        assert.strictEqual(its[0].ciResult, 'none');
    });

    test('stops when aborted', async () => {
        const { forge, commits } = fakeForge({ checks: [passing] });
        const controller = new AbortController();
        controller.abort('stop');
        const coder = new Coder(logger, new OutputValidator(), stamps, audit, fakeLlm([{ path: 'src/a.ts', content: 'x' }]).llm);
        await assert.rejects(coder.code(forge, issue(), evaluation, investigation, { ...options, signal: controller.signal }));
        assert.strictEqual(commits.length, 0);
    });
});
