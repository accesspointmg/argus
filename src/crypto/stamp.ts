// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Cryptographic stamp — HMAC-SHA256 signing and verification for all Argus artifacts.
 */

import { createHash, createHmac, randomBytes } from 'crypto';
import type { ArgusStamp, StampVerification } from './types';
import type { KeyManager } from './keys';
import type { NonceRegistry } from './nonce-registry';

const VERSION = '0.1.0';
const STAMP_DELIMITER = '\n\n---\n';
const STAMP_REGEX = /<sub>🔏 Argus v[\d.]+ · <code>([a-f0-9]+)<\/code> · ([\d\-T:.Z]+) · <code>sig:([a-f0-9]+):([a-f0-9]+)<\/code><\/sub>/;

export class StampManager {
    constructor(
        private readonly keyManager: KeyManager,
        private readonly nonceRegistry: NonceRegistry,
    ) {}

    /** Expose the instance ID from the key manager. */
    get instanceId(): string {
        return this.keyManager.instanceId;
    }

    /** Generate a stamp for the given content. */
    generate(content: string): ArgusStamp {
        const instanceId = this.keyManager.instanceId;
        const timestamp = new Date().toISOString();
        const nonce = randomBytes(8).toString('hex');
        const contentHash = createHash('sha256').update(content).digest('hex');

        const message = `${instanceId}|${timestamp}|${nonce}|${contentHash}`;
        const signature = createHmac('sha256', this.keyManager.getSigningKey())
            .update(message)
            .digest('hex');

        return { instanceId, version: VERSION, timestamp, nonce, contentHash, signature };
    }

    /** Format a stamp as a markdown footer to append to a comment. */
    formatStamp(stamp: ArgusStamp): string {
        const shortId = stamp.instanceId.substring(0, 8);
        return `${STAMP_DELIMITER}<sub>🔏 Argus v${stamp.version} · <code>${shortId}</code> · ${stamp.timestamp} · <code>sig:${stamp.nonce}:${stamp.signature}</code></sub>`;
    }

    /** Stamp content: append a cryptographic stamp to the content string. */
    stampContent(content: string): { stamped: string; stamp: ArgusStamp } {
        const stamp = this.generate(content);
        const stamped = content + this.formatStamp(stamp);
        return { stamped, stamp };
    }

    /** Verify a stamp on a comment body. */
    verify(commentBody: string, commentId?: string): StampVerification {
        // Split content from stamp
        const delimiterIdx = commentBody.lastIndexOf(STAMP_DELIMITER);
        if (delimiterIdx === -1) {
            return { valid: false, reason: 'No stamp delimiter found', isOurInstance: false, tampered: false, replayed: false };
        }

        const content = commentBody.substring(0, delimiterIdx);
        const stampBlock = commentBody.substring(delimiterIdx);

        // Parse stamp
        const match = STAMP_REGEX.exec(stampBlock);
        if (!match) {
            return { valid: false, reason: 'Stamp format invalid', isOurInstance: false, tampered: false, replayed: false };
        }

        const [, shortInstanceId, timestamp, nonce, signature] = match;
        const instanceId = this.keyManager.instanceId;
        const isOurInstance = instanceId.startsWith(shortInstanceId);

        if (!isOurInstance) {
            return {
                valid: false,
                reason: `Different Argus instance (${shortInstanceId})`,
                isOurInstance: false,
                tampered: false,
                replayed: false,
            };
        }

        // Recompute content hash
        const contentHash = createHash('sha256').update(content).digest('hex');

        // Try verification against all keys (current + rotated)
        const message = `${instanceId}|${timestamp}|${nonce}|${contentHash}`;
        let signatureValid = false;
        for (const key of this.keyManager.getVerificationKeys()) {
            const expected = createHmac('sha256', key).update(message).digest('hex');
            if (expected === signature) {
                signatureValid = true;
                break;
            }
        }

        if (!signatureValid) {
            return {
                valid: false,
                reason: 'Invalid signature — content may have been tampered with',
                isOurInstance: true,
                tampered: true,
                replayed: false,
            };
        }

        // Anti-replay check
        const existingNonce = this.nonceRegistry.lookup(nonce);
        if (existingNonce && commentId && existingNonce.commentId !== commentId) {
            return {
                valid: false,
                reason: 'Nonce replay detected — stamp copied from another comment',
                isOurInstance: true,
                tampered: false,
                replayed: true,
            };
        }

        // Register nonce if not already registered
        if (commentId && !existingNonce) {
            this.nonceRegistry.register({
                nonce,
                timestamp,
                repo: '',
                commentId,
                action: 'verify',
            });
        }

        // Timestamp sanity check
        const stampTime = new Date(timestamp).getTime();
        const age = Date.now() - stampTime;
        if (age < -60_000) {
            return {
                valid: false,
                reason: 'Timestamp is in the future',
                isOurInstance: true,
                tampered: false,
                replayed: false,
            };
        }

        const stamp: ArgusStamp = {
            instanceId,
            version: VERSION,
            timestamp,
            nonce,
            contentHash,
            signature,
        };

        return { valid: true, stamp, isOurInstance: true, tampered: false, replayed: false };
    }

    /** Check if a comment body contains an Argus stamp (any instance). */
    hasStamp(commentBody: string): boolean {
        return STAMP_REGEX.test(commentBody);
    }

    /** Extract the instance ID from a stamp without full verification. */
    extractInstanceId(commentBody: string): string | null {
        const match = STAMP_REGEX.exec(commentBody);
        return match ? match[1] : null;
    }
}
