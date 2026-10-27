// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Chained audit log — append-only, hash-linked, HMAC-signed entries.
 *
 * Bounded: only the newest MAX_ENTRIES are kept (globalState is one JSON blob
 * per extension, rewritten on every update). Trimming writes a signed
 * checkpoint holding the hash of the last dropped entry, so the retained
 * chain still verifies from the checkpoint forward.
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import type * as vscode from 'vscode';
import type { AuditEntry, AuditAction } from '../security/types';
import type { KeyManager } from './keys';

const AUDIT_LOG_KEY_PREFIX = 'argus.auditLog.';
const AUDIT_COUNTER_KEY = 'argus.auditCounter';
const AUDIT_CHECKPOINT_KEY = 'argus.auditCheckpoint';
const GENESIS = '0'.repeat(64);

/** Entries retained. */
export const MAX_AUDIT_ENTRIES = 2000;
/** Trim in batches so we don't rewrite state on every append. */
const TRIM_BATCH = 200;

interface AuditCheckpoint {
    /** First retained entry number (1-based). */
    firstIndex: number;
    /** Hash of entry `firstIndex - 1` (the expected `previousEntryHash` of the first retained). */
    prevHash: string;
    createdAt: string;
    keyId: string;
    signature: string;
}

export interface AuditLogOptions {
    maxEntries?: number;
}

export class AuditLog {
    private counter = 0;
    private lastEntryHash = GENESIS;
    private readonly maxEntries: number;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly keyManager: KeyManager,
        private readonly globalState: vscode.Memento,
        private readonly outputChannel: vscode.OutputChannel,
        options: AuditLogOptions = {},
    ) {
        this.maxEntries = Math.max(10, options.maxEntries ?? MAX_AUDIT_ENTRIES);
    }

    async load(): Promise<void> {
        this.counter = this.globalState.get<number>(AUDIT_COUNTER_KEY, 0);
        this.lastEntryHash = GENESIS;
        if (this.counter > 0) {
            const last = this.getEntry(this.counter);
            if (last) {
                this.lastEntryHash = hashEntry(last);
            } else {
                const cp = this.checkpoint();
                if (cp && cp.firstIndex === this.counter + 1) { this.lastEntryHash = cp.prevHash; }
            }
        }
    }

    /** Append a new entry. Appends are serialized so the chain can't fork. */
    append(params: {
        action: AuditAction;
        repo: string;
        target: string;
        input: string;
        output: string;
        decision: string;
        llmCallCount: number;
        details: string;
    }): Promise<AuditEntry> {
        const run = this.queue.then(() => this.appendNow(params));
        this.queue = run.catch(() => undefined);
        return run;
    }

    private async appendNow(params: Parameters<AuditLog['append']>[0]): Promise<AuditEntry> {
        this.counter++;
        const id = pad(this.counter);
        const entry: AuditEntry = {
            id,
            timestamp: new Date().toISOString(),
            action: params.action,
            repo: params.repo,
            target: params.target,
            inputHash: createHash('sha256').update(params.input ?? '').digest('hex'),
            outputHash: createHash('sha256').update(params.output ?? '').digest('hex'),
            decision: params.decision,
            llmCallCount: params.llmCallCount,
            details: params.details,
            previousEntryHash: this.lastEntryHash,
            signature: '',
            keyId: this.keyManager.currentKeyId,
            v: 2,
        };
        entry.signature = createHmac('sha256', this.keyManager.getSigningKey())
            .update(signaturePayload(entry))
            .digest('hex');

        this.lastEntryHash = hashEntry(entry);

        await this.globalState.update(`${AUDIT_LOG_KEY_PREFIX}${id}`, entry);
        await this.globalState.update(AUDIT_COUNTER_KEY, this.counter);
        await this.trimIfNeeded();

        this.outputChannel.appendLine(
            `[AUDIT ${entry.id}] ${entry.timestamp} ${entry.action} → ${entry.decision} | ${entry.details}`,
        );
        return entry;
    }

    /** Verify the retained chain (from the checkpoint, if any). */
    async verifyChain(): Promise<{ valid: boolean; brokenAt?: string; errors: string[]; verified: number }> {
        await this.queue;
        const errors: string[] = [];
        let start = 1;
        let expectedPrevHash = GENESIS;

        const cp = this.checkpoint();
        if (cp) {
            if (!this.verifyCheckpoint(cp)) {
                errors.push('Checkpoint: invalid signature');
                return { valid: false, brokenAt: 'checkpoint', errors, verified: 0 };
            }
            start = cp.firstIndex;
            expectedPrevHash = cp.prevHash;
        }

        let verified = 0;
        for (let i = start; i <= this.counter; i++) {
            const id = pad(i);
            const entry = this.getEntry(i);
            if (!entry) {
                errors.push(`Entry ${id}: MISSING`);
                return { valid: false, brokenAt: id, errors, verified };
            }
            if (entry.id !== id) {
                errors.push(`Entry ${id}: id mismatch`);
                return { valid: false, brokenAt: id, errors, verified };
            }
            if (entry.previousEntryHash !== expectedPrevHash) {
                errors.push(`Entry ${id}: chain broken — expected prev hash ${expectedPrevHash.substring(0, 16)}...`);
                return { valid: false, brokenAt: id, errors, verified };
            }
            const sig = this.checkSignature(entry);
            if (sig !== 'ok') {
                errors.push(`Entry ${id}: ${sig === 'retired' ? `signed with a key no longer retained (${entry.keyId})` : 'invalid signature'}`);
                return { valid: false, brokenAt: id, errors, verified };
            }
            expectedPrevHash = hashEntry(entry);
            verified++;
        }
        return { valid: true, errors: [], verified };
    }

    /** Total entries ever appended. */
    get totalEntries(): number {
        return this.counter;
    }

    /** Index of the oldest retained entry (1-based). */
    get firstRetainedIndex(): number {
        return this.checkpoint()?.firstIndex ?? 1;
    }

    /** Get a specific entry by index (1-based). Undefined once trimmed. */
    getEntry(index: number): AuditEntry | undefined {
        return this.globalState.get<AuditEntry>(`${AUDIT_LOG_KEY_PREFIX}${pad(index)}`);
    }

    // ─── Internals ──────────────────────────────────────────────

    private checkpoint(): AuditCheckpoint | undefined {
        return this.globalState.get<AuditCheckpoint>(AUDIT_CHECKPOINT_KEY);
    }

    private async trimIfNeeded(): Promise<void> {
        const first = this.firstRetainedIndex;
        const retained = this.counter - first + 1;
        const batch = Math.max(1, Math.min(TRIM_BATCH, Math.floor(this.maxEntries / 10)));
        if (retained <= this.maxEntries + batch) { return; }

        const newFirst = this.counter - this.maxEntries + 1;
        const boundary = this.getEntry(newFirst - 1);
        if (!boundary) { return; } // can't anchor safely; leave as is
        const cp: AuditCheckpoint = {
            firstIndex: newFirst,
            prevHash: hashEntry(boundary),
            createdAt: new Date().toISOString(),
            keyId: this.keyManager.currentKeyId,
            signature: '',
        };
        cp.signature = createHmac('sha256', this.keyManager.getSigningKey()).update(checkpointPayload(cp)).digest('hex');

        // Write the checkpoint before deleting, so a crash mid-trim leaves a verifiable state.
        await this.globalState.update(AUDIT_CHECKPOINT_KEY, cp);
        for (let i = first; i < newFirst; i++) {
            await this.globalState.update(`${AUDIT_LOG_KEY_PREFIX}${pad(i)}`, undefined);
        }
    }

    private verifyCheckpoint(cp: AuditCheckpoint): boolean {
        const keys = cp.keyId ? [this.keyManager.getKey(cp.keyId)].filter((k): k is Buffer => !!k) : this.keyManager.getVerificationKeys();
        return keys.some((k) => safeEqualHex(createHmac('sha256', k).update(checkpointPayload(cp)).digest('hex'), cp.signature));
    }

    private checkSignature(entry: AuditEntry): 'ok' | 'invalid' | 'retired' {
        const payload = entry.v === 2 ? signaturePayload(entry) : legacyPayload(entry);
        if (entry.keyId) {
            const key = this.keyManager.getKey(entry.keyId);
            if (!key) { return 'retired'; }
            return safeEqualHex(createHmac('sha256', key).update(payload).digest('hex'), entry.signature) ? 'ok' : 'invalid';
        }
        return this.keyManager.getVerificationKeys().some((k) =>
            safeEqualHex(createHmac('sha256', k).update(payload).digest('hex'), entry.signature)) ? 'ok' : 'invalid';
    }
}

function pad(n: number): string {
    return n.toString().padStart(8, '0');
}

function hashEntry(entry: AuditEntry): string {
    return createHash('sha256').update(JSON.stringify(entry)).digest('hex');
}

/** v2: every field except the signature itself. */
function signaturePayload(e: AuditEntry): string {
    return JSON.stringify([
        e.v, e.id, e.timestamp, e.action, e.repo, e.target, e.inputHash, e.outputHash,
        e.decision, e.llmCallCount, e.details, e.previousEntryHash, e.keyId,
    ]);
}

/** Entries written before v2. */
function legacyPayload(e: AuditEntry): string {
    return `${e.id}|${e.timestamp}|${e.action}|${e.repo}|${e.target}|${e.inputHash}|${e.outputHash}|${e.decision}|${e.previousEntryHash}`;
}

function checkpointPayload(cp: AuditCheckpoint): string {
    return JSON.stringify(['checkpoint', cp.firstIndex, cp.prevHash, cp.createdAt, cp.keyId]);
}

function safeEqualHex(a: string, b: string): boolean {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) { return false; }
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
