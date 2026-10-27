// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Nonce registry — anti-replay protection for cryptographic stamps.
 *
 * Each stamp nonce is bound to the first artifact (comment id / `pr:<n>`)
 * it is seen on; the same valid stamp on a different artifact is a replay.
 * Self-persisting: every change is written to the Memento (coalesced), and
 * entries older than `argus.crypto.nonceRetentionDays` are pruned on load and
 * periodically.
 */

import type * as vscode from 'vscode';
import type { NonceEntry } from './types';
import { readSetting, type SettingReader } from '../security/settings';

const NONCE_REGISTRY_KEY = 'argus.nonceRegistry';
const MAX_ENTRIES = 20_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class NonceRegistry {
    private registry: Map<string, NonceEntry> = new Map();
    private saving: Promise<void> = Promise.resolve();
    private dirty = false;
    private lastPrune = 0;

    constructor(
        private readonly globalState: vscode.Memento,
        private readonly settings: SettingReader = readSetting,
    ) {}

    /** Load persisted nonces and prune expired ones. */
    async load(): Promise<void> {
        const stored = this.globalState.get<Record<string, NonceEntry>>(NONCE_REGISTRY_KEY, {});
        this.registry = new Map(Object.entries(stored ?? {}));
        if (this.prune() > 0) { await this.save(); }
    }

    /** Persist now. Normally unnecessary — changes save themselves. */
    async save(): Promise<void> {
        this.dirty = true;
        this.scheduleSave();
        await this.saving;
    }

    /** Wait for pending writes (e.g. on deactivate). */
    async flush(): Promise<void> {
        await this.saving;
    }

    /** Register (or overwrite) a nonce. Persists in the background. */
    register(entry: NonceEntry): void {
        this.registry.set(entry.nonce, entry);
        if (this.registry.size > MAX_ENTRIES) { this.evictOldest(this.registry.size - MAX_ENTRIES); }
        if (Date.now() - this.lastPrune > PRUNE_INTERVAL_MS) { this.prune(); }
        this.dirty = true;
        this.scheduleSave();
    }

    lookup(nonce: string): NonceEntry | undefined {
        return this.registry.get(nonce);
    }

    has(nonce: string): boolean {
        return this.registry.has(nonce);
    }

    /**
     * Prune nonces older than `retentionDays` (default: the
     * `argus.crypto.nonceRetentionDays` setting). Returns how many were removed.
     */
    prune(retentionDays?: number): number {
        const days = retentionDays ?? this.settings('crypto.nonceRetentionDays', 30);
        this.lastPrune = Date.now();
        if (!(days >= 0)) { return 0; }
        const cutoff = Date.now() - days * DAY_MS;
        let pruned = 0;
        for (const [nonce, entry] of this.registry) {
            const t = new Date(entry.timestamp).getTime();
            if (!Number.isFinite(t) || t < cutoff) {
                this.registry.delete(nonce);
                pruned++;
            }
        }
        if (pruned > 0) {
            this.dirty = true;
            this.scheduleSave();
        }
        return pruned;
    }

    get size(): number {
        return this.registry.size;
    }

    private evictOldest(count: number): void {
        const sorted = [...this.registry.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        for (const e of sorted.slice(0, count)) { this.registry.delete(e.nonce); }
    }

    /** Coalesce writes: at most one in flight, one queued. */
    private scheduleSave(): void {
        this.saving = this.saving.then(async () => {
            if (!this.dirty) { return; }
            this.dirty = false;
            try {
                await this.globalState.update(NONCE_REGISTRY_KEY, Object.fromEntries(this.registry));
            } catch {
                this.dirty = true; // retry on next change
            }
        });
    }
}
