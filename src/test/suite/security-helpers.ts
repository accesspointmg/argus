// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Test doubles for the security / crypto suites. No VS Code API needed.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type * as vscode from 'vscode';
import type { Logger } from '../../util/logger';
import type { LlmService } from '../../llm';
import type { UserTrustProfile } from '../../security/types';

export class MemoryMemento implements vscode.Memento {
    data = new Map<string, unknown>();
    keys(): readonly string[] { return [...this.data.keys()]; }
    get<T>(key: string, defaultValue?: T): T | undefined {
        return this.data.has(key) ? this.data.get(key) as T : defaultValue;
    }
    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) { this.data.delete(key); } else { this.data.set(key, JSON.parse(JSON.stringify(value))); }
    }
}

export class MemorySecrets {
    data = new Map<string, string>();
    async get(key: string): Promise<string | undefined> { return this.data.get(key); }
    async store(key: string, value: string): Promise<void> { this.data.set(key, value); }
    async delete(key: string): Promise<void> { this.data.delete(key); }
    onDidChange = (() => ({ dispose() { /* noop */ } })) as any;
    keys = async (): Promise<string[]> => [...this.data.keys()];
}

export function silentLogger(): Logger {
    const noop = (): void => { /* quiet */ };
    return { debug: noop, info: noop, warn: noop, error: noop, setLevel: noop } as unknown as Logger;
}

export function fakeChannel(): vscode.OutputChannel {
    return { appendLine: () => { /* quiet */ } } as unknown as vscode.OutputChannel;
}

/** An LLM double. `reply` receives the request and returns text or throws. */
export function fakeLlm(reply: (req: { system?: string; messages: { text: string }[] }) => string | Promise<string>): LlmService & { calls: number } {
    const llm = {
        calls: 0,
        async isAvailable() { return true; },
        async chat(req: any) { llm.calls++; return reply(req); },
    };
    return llm as unknown as LlmService & { calls: number };
}

/** The canary a framed prompt asked for. */
export function canaryOf(req: { system?: string }): string {
    const m = /"canary": "([a-f0-9]{16})"/.exec(req.system ?? '');
    if (!m) { throw new Error('no canary in prompt'); }
    return m[1];
}

export function profile(score: number, tier: UserTrustProfile['tier'] = 'unknown', username = 'someone'): UserTrustProfile {
    return {
        username,
        tier,
        baseTrustScore: score,
        historyModifier: 0,
        effectiveTrustScore: score,
        repoRole: 'none',
        history: { mergedPRs: 0, closedIssuesAsValid: 0, previousFlags: 0, previousBlocks: 0, totalComments: 0 },
        lastUpdated: new Date(),
    };
}
