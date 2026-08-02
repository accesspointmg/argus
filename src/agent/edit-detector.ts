// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Edit detector — detects post-approval edits to issue bodies.
 *
 * When Argus evaluates an issue, it records a SHA-256 hash of the body.
 * If the body changes after evaluation, this may indicate a bait-and-switch
 * attack where the issue is rewritten to be malicious after gaining trust.
 */

import { createHash } from 'crypto';
import type { Forge, Issue } from '../forge/types';
import type { TrackedIssue } from './types';
import type { Logger } from '../util/logger';
import type { AuditLog } from '../crypto/audit';

export interface EditDetection {
    detected: boolean;
    issueNumber: number;
    previousHash: string;
    currentHash: string;
    action: 'none' | 'halt' | 'reevaluate';
    reason: string;
}

export class EditDetector {
    constructor(
        private readonly logger: Logger,
        private readonly auditLog: AuditLog,
    ) {}

    /**
     * Compute SHA-256 hash of an issue body.
     */
    hashBody(body: string): string {
        return createHash('sha256').update(body || '').digest('hex');
    }

    /**
     * Check if an issue has been edited since it was evaluated.
     */
    async check(
        forge: Forge,
        tracked: TrackedIssue,
    ): Promise<EditDetection> {
        let currentIssue: Issue;
        try {
            currentIssue = await forge.getIssue(tracked.issueNumber);
        } catch (err) {
            this.logger.warn(`Failed to fetch issue #${tracked.issueNumber} for edit check: ${err}`);
            return {
                detected: false,
                issueNumber: tracked.issueNumber,
                previousHash: tracked.bodyHash,
                currentHash: 'UNKNOWN',
                action: 'none',
                reason: `Failed to fetch issue: ${err}`,
            };
        }

        const currentHash = this.hashBody(currentIssue.body);

        if (currentHash === tracked.bodyHash) {
            return {
                detected: false,
                issueNumber: tracked.issueNumber,
                previousHash: tracked.bodyHash,
                currentHash,
                action: 'none',
                reason: 'No edits detected',
            };
        }

        // Edit detected!
        this.logger.warn(
            `Edit detected on issue #${tracked.issueNumber}: ` +
            `hash ${tracked.bodyHash.substring(0, 8)}→${currentHash.substring(0, 8)}`
        );

        // Determine severity based on when the edit happened
        const editedDuringCoding = tracked.state === 'coding' || tracked.state === 'iterating';
        const editedAfterPR = tracked.state === 'pr-open';

        let action: EditDetection['action'] = 'reevaluate';
        let reason = 'Issue body was edited after evaluation';

        if (editedDuringCoding) {
            action = 'halt';
            reason = 'Issue body edited while Argus was coding — aborting to prevent bait-and-switch';
        } else if (editedAfterPR) {
            action = 'reevaluate';
            reason = 'Issue body edited after PR was opened — PR should be re-evaluated';
        }

        await this.auditLog.append({
            action: 'detect_edit',
            repo: `${forge.owner}/${forge.repo}`,
            target: `#${tracked.issueNumber}`,
            input: tracked.bodyHash,
            output: currentHash,
            decision: action,
            llmCallCount: 0,
            details: reason,
        });

        return {
            detected: true,
            issueNumber: tracked.issueNumber,
            previousHash: tracked.bodyHash,
            currentHash,
            action,
            reason,
        };
    }
}
