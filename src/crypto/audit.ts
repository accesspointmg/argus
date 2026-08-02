// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Chained audit log — append-only, hash-linked, HMAC-signed entries.
 */

import { createHash, createHmac } from 'crypto';
import * as vscode from 'vscode';
import type { AuditEntry, AuditAction } from '../security/types';
import type { KeyManager } from './keys';

const AUDIT_LOG_KEY_PREFIX = 'argus.auditLog.';
const AUDIT_COUNTER_KEY = 'argus.auditCounter';

export class AuditLog {
    private counter: number = 0;
    private lastEntryHash: string = '0'.repeat(64); // Genesis hash

    constructor(
        private readonly keyManager: KeyManager,
        private readonly globalState: vscode.Memento,
        private readonly outputChannel: vscode.OutputChannel,
    ) {}

    /** Load state from globalState. */
    async load(): Promise<void> {
        this.counter = this.globalState.get<number>(AUDIT_COUNTER_KEY, 0);
        // Load the last entry hash for chain continuity
        if (this.counter > 0) {
            const lastId = this.counter.toString().padStart(8, '0');
            const lastEntry = this.globalState.get<AuditEntry>(`${AUDIT_LOG_KEY_PREFIX}${lastId}`);
            if (lastEntry) {
                this.lastEntryHash = this.hashEntry(lastEntry);
            }
        }
    }

    /** Append a new audit entry. */
    async append(params: {
        action: AuditAction;
        repo: string;
        target: string;
        input: string;
        output: string;
        decision: string;
        llmCallCount: number;
        details: string;
    }): Promise<AuditEntry> {
        this.counter++;
        const id = this.counter.toString().padStart(8, '0');

        const entry: AuditEntry = {
            id,
            timestamp: new Date().toISOString(),
            action: params.action,
            repo: params.repo,
            target: params.target,
            inputHash: createHash('sha256').update(params.input).digest('hex'),
            outputHash: createHash('sha256').update(params.output).digest('hex'),
            decision: params.decision,
            llmCallCount: params.llmCallCount,
            details: params.details,
            previousEntryHash: this.lastEntryHash,
            signature: '', // Computed below
        };

        // Sign the entry
        const sigPayload = `${entry.id}|${entry.timestamp}|${entry.action}|${entry.repo}|${entry.target}|${entry.inputHash}|${entry.outputHash}|${entry.decision}|${entry.previousEntryHash}`;
        entry.signature = createHmac('sha256', this.keyManager.getSigningKey())
            .update(sigPayload)
            .digest('hex');

        // Update chain
        this.lastEntryHash = this.hashEntry(entry);

        // Persist
        await this.globalState.update(`${AUDIT_LOG_KEY_PREFIX}${id}`, entry);
        await this.globalState.update(AUDIT_COUNTER_KEY, this.counter);

        // Log to output channel
        this.outputChannel.appendLine(
            `[AUDIT ${entry.id}] ${entry.timestamp} ${entry.action} → ${entry.decision} | ${entry.details}`
        );

        return entry;
    }

    /** Verify the integrity of the audit chain. */
    async verifyChain(): Promise<{ valid: boolean; brokenAt?: string; errors: string[] }> {
        const errors: string[] = [];
        let expectedPrevHash = '0'.repeat(64);

        for (let i = 1; i <= this.counter; i++) {
            const id = i.toString().padStart(8, '0');
            const entry = this.globalState.get<AuditEntry>(`${AUDIT_LOG_KEY_PREFIX}${id}`);

            if (!entry) {
                errors.push(`Entry ${id}: MISSING`);
                return { valid: false, brokenAt: id, errors };
            }

            // Check chain link
            if (entry.previousEntryHash !== expectedPrevHash) {
                errors.push(`Entry ${id}: Chain broken — expected prev hash ${expectedPrevHash.substring(0, 16)}...`);
                return { valid: false, brokenAt: id, errors };
            }

            // Verify signature
            const sigPayload = `${entry.id}|${entry.timestamp}|${entry.action}|${entry.repo}|${entry.target}|${entry.inputHash}|${entry.outputHash}|${entry.decision}|${entry.previousEntryHash}`;
            let sigValid = false;
            for (const key of this.keyManager.getVerificationKeys()) {
                const expected = createHmac('sha256', key).update(sigPayload).digest('hex');
                if (expected === entry.signature) {
                    sigValid = true;
                    break;
                }
            }
            if (!sigValid) {
                errors.push(`Entry ${id}: Invalid signature`);
                return { valid: false, brokenAt: id, errors };
            }

            expectedPrevHash = this.hashEntry(entry);
        }

        return { valid: true, errors: [] };
    }

    /** Get total entry count. */
    get totalEntries(): number {
        return this.counter;
    }

    /** Get a specific entry by index (1-based). */
    getEntry(index: number): AuditEntry | undefined {
        const id = index.toString().padStart(8, '0');
        return this.globalState.get<AuditEntry>(`${AUDIT_LOG_KEY_PREFIX}${id}`);
    }

    private hashEntry(entry: AuditEntry): string {
        return createHash('sha256')
            .update(JSON.stringify(entry))
            .digest('hex');
    }
}
