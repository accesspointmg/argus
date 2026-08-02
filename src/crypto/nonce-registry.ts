// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Nonce registry — anti-replay protection for cryptographic stamps.
 */

import * as vscode from 'vscode';
import type { NonceEntry } from './types';

const NONCE_REGISTRY_KEY = 'argus.nonceRegistry';

export class NonceRegistry {
    private registry: Map<string, NonceEntry> = new Map();

    constructor(private readonly globalState: vscode.Memento) {}

    /** Load persisted nonces from globalState. */
    async load(): Promise<void> {
        const stored = this.globalState.get<Record<string, NonceEntry>>(NONCE_REGISTRY_KEY, {});
        this.registry = new Map(Object.entries(stored));
    }

    /** Persist nonces to globalState. */
    async save(): Promise<void> {
        const obj = Object.fromEntries(this.registry);
        await this.globalState.update(NONCE_REGISTRY_KEY, obj);
    }

    /** Register a new nonce. */
    register(entry: NonceEntry): void {
        this.registry.set(entry.nonce, entry);
    }

    /** Look up a nonce. Returns the entry if found. */
    lookup(nonce: string): NonceEntry | undefined {
        return this.registry.get(nonce);
    }

    /** Check if a nonce exists. */
    has(nonce: string): boolean {
        return this.registry.has(nonce);
    }

    /** Prune nonces older than the given retention period. */
    prune(retentionDays: number): number {
        const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
        let pruned = 0;
        for (const [nonce, entry] of this.registry) {
            if (new Date(entry.timestamp).getTime() < cutoff) {
                this.registry.delete(nonce);
                pruned++;
            }
        }
        return pruned;
    }

    /** Get the total number of registered nonces. */
    get size(): number {
        return this.registry.size;
    }
}
