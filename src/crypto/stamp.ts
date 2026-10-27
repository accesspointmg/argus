// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Cryptographic stamp — HMAC-SHA256 signing and verification for all Argus artifacts.
 *
 * Footer: `<sub>🔏 Argus v… · <code>{instanceId}</code> · {iso} · <code>sig:{nonce}:{hmac}</code></sub>`
 * HMAC input: `{instanceId}|{timestamp}|{nonce}|sha256(content before the footer)`.
 *
 * Only `verifyBody` / `isOwnAuthentic` prove anything. Anyone can paste a
 * footer, so `hasStamp` / `claimedInstanceId` are unverified hints and must
 * never decide behavior that a forger would benefit from. Another instance's
 * stamp can't be verified (we don't hold its key) — see security/sovereignty.ts.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import type { ArgusStamp, StampVerification } from './types';
import type { KeyManager } from './keys';
import type { NonceRegistry } from './nonce-registry';

const VERSION = '0.1.0';
const STAMP_DELIMITER = '\n\n---\n';
// Instance ids are 16 hex chars; stamps written before this fix carry the first 8.
const STAMP_LINE = /<sub>🔏 Argus v[\d.]+ · <code>([a-f0-9]{8,16})<\/code> · ([\d\-T:.Z]+) · <code>sig:([a-f0-9]{16}):([a-f0-9]{64})<\/code><\/sub>/;
const STAMP_AT_END = new RegExp(`^${STAMP_LINE.source}\\s*$`);

/** Kinds of artifact a stamp can be bound to for anti-replay. */
export type ArtifactKind = 'pr' | 'issue' | 'comment' | 'review';

/**
 * Canonical artifact id for nonce binding. Every caller must use this so the
 * same artifact always gets the same id (a mismatch reads as a replay).
 * `repoKey` is `platform:owner/repo`; `id` is the PR/issue number or comment id.
 */
export function artifactId(repoKey: string, kind: ArtifactKind, id: string | number): string {
    return `${kind}:${repoKey.toLowerCase()}#${id}`;
}

export interface BodyVerification {
    /** Authentic stamp by THIS instance over exactly this content. */
    valid: boolean;
    /** Our instance id, set only when valid. */
    instanceId?: string;
    /** Instance id the footer claims (unverified). */
    claimedInstanceId?: string;
    reason?: string;
    replayed?: boolean;
}

export class StampManager {
    constructor(
        private readonly keyManager: KeyManager,
        private readonly nonceRegistry: NonceRegistry,
    ) {}

    get instanceId(): string {
        return this.keyManager.instanceId;
    }

    /** Generate a stamp for the given content. Registers its nonce (unbound). */
    generate(content: string): ArgusStamp {
        const instanceId = this.keyManager.instanceId;
        const timestamp = new Date().toISOString();
        const nonce = randomBytes(8).toString('hex');
        const contentHash = sha256(content);
        const signature = hmac(this.keyManager.getSigningKey(), `${instanceId}|${timestamp}|${nonce}|${contentHash}`);

        this.nonceRegistry.register({ nonce, timestamp, repo: '', commentId: '', action: 'stamp' });
        return { instanceId, version: VERSION, timestamp, nonce, contentHash, signature };
    }

    /** Format a stamp as a markdown footer. Carries the full instance id. */
    formatStamp(stamp: ArgusStamp): string {
        return `${STAMP_DELIMITER}<sub>🔏 Argus v${stamp.version} · <code>${stamp.instanceId}</code> · ${stamp.timestamp} · <code>sig:${stamp.nonce}:${stamp.signature}</code></sub>`;
    }

    /** Append a stamp to content. */
    /**
     * Applied to content before it is signed (the controller uses it to redact
     * strings that must never be published). Redacting after signing would
     * invalidate the stamp.
     */
    contentFilter: (content: string) => string = (c) => c;

    stampContent(content: string): { stamped: string; stamp: ArgusStamp } {
        const filtered = this.contentFilter(content);
        const stamp = this.generate(filtered);
        return { stamped: filtered + this.formatStamp(stamp), stamp };
    }

    /**
     * Bind a stamp's nonce to the artifact it was posted as (see
     * {@link artifactId}). Call after posting; later copies of the same stamp
     * elsewhere then verify as replays.
     */
    recordPosted(stamp: ArgusStamp, artifactId: string, repo = ''): void {
        if (!artifactId) { return; }
        this.nonceRegistry.register({ nonce: stamp.nonce, timestamp: stamp.timestamp, repo, commentId: artifactId, action: 'posted' });
    }

    /**
     * Full verification of a body's stamp.
     * @param commentId The artifact the body came from ({@link artifactId}). With it, a nonce
     *                  already bound to a different artifact is a replay;
     *                  an unbound nonce is bound to this artifact.
     */
    verify(commentBody: string, commentId?: string): StampVerification {
        const fail = (reason: string, extra: Partial<StampVerification> = {}): StampVerification =>
            ({ valid: false, reason, isOurInstance: false, tampered: false, replayed: false, ...extra });

        const parsed = parseFooter(commentBody);
        if (!parsed) { return fail('No stamp found at end of body'); }

        const { content, claimedId, timestamp, nonce, signature } = parsed;
        const instanceId = this.keyManager.instanceId;
        const isOurInstance = instanceId.length > 0 &&
            (claimedId.length === 16 ? claimedId === instanceId : instanceId.startsWith(claimedId));
        if (!isOurInstance) {
            return fail(`Different (or forged) Argus instance (${claimedId})`);
        }

        const contentHash = sha256(content);
        const message = `${instanceId}|${timestamp}|${nonce}|${contentHash}`;
        const sigBuf = Buffer.from(signature, 'hex');
        const signatureValid = this.keyManager.getVerificationKeys().some((key) => {
            const expected = createHmac('sha256', key).update(message).digest();
            return expected.length === sigBuf.length && timingSafeEqual(expected, sigBuf);
        });
        if (!signatureValid) {
            return fail('Invalid signature — forged, or content was edited', { isOurInstance: true, tampered: true });
        }

        const stampTime = new Date(timestamp).getTime();
        if (!Number.isFinite(stampTime) || stampTime - Date.now() > 60_000) {
            return fail('Timestamp is invalid or in the future', { isOurInstance: true });
        }

        if (commentId) {
            const existing = this.nonceRegistry.lookup(nonce);
            if (existing && existing.commentId && existing.commentId !== commentId) {
                return fail('Nonce replay — stamp copied from another artifact', { isOurInstance: true, replayed: true });
            }
            if (!existing || !existing.commentId) {
                this.nonceRegistry.register({ nonce, timestamp, repo: existing?.repo ?? '', commentId, action: 'verify' });
            }
        }

        return {
            valid: true,
            stamp: { instanceId, version: VERSION, timestamp, nonce, contentHash, signature },
            isOurInstance: true,
            tampered: false,
            replayed: false,
        };
    }

    /** Verify a body. `valid` only for an authentic stamp of THIS instance. */
    verifyBody(body: string, artifactId?: string): BodyVerification {
        if (typeof body !== 'string') { return { valid: false, reason: 'No body' }; }
        const claimed = parseFooter(body)?.claimedId;
        const v = this.verify(body, artifactId);
        return {
            valid: v.valid,
            instanceId: v.valid ? this.keyManager.instanceId : undefined,
            claimedInstanceId: claimed,
            reason: v.reason,
            replayed: v.replayed || undefined,
        };
    }

    /** True iff `body` carries an authentic, non-replayed stamp from this instance. */
    isOwnAuthentic(body: string, artifactId?: string): boolean {
        return this.verifyBody(body, artifactId).valid;
    }

    /**
     * The instance id a footer CLAIMS, unverified. Use only for deference
     * (sovereignty), never to grant trust or skip moderation.
     */
    claimedInstanceId(body: string): string | null {
        return parseFooter(body)?.claimedId ?? null;
    }

    /**
     * @deprecated Unverified — anyone can paste a footer. Use
     * {@link isOwnAuthentic} for decisions.
     */
    hasStamp(commentBody: string): boolean {
        return STAMP_LINE.test(commentBody ?? '');
    }

    /** @deprecated Unverified. Use {@link verifyBody} or {@link claimedInstanceId}. */
    extractInstanceId(commentBody: string): string | null {
        const match = STAMP_LINE.exec(commentBody ?? '');
        return match ? match[1] : null;
    }
}

function parseFooter(body: string): { content: string; claimedId: string; timestamp: string; nonce: string; signature: string } | null {
    if (typeof body !== 'string') { return null; }
    const idx = body.lastIndexOf(STAMP_DELIMITER);
    if (idx === -1) { return null; }
    const m = STAMP_AT_END.exec(body.substring(idx + STAMP_DELIMITER.length));
    if (!m) { return null; }
    return { content: body.substring(0, idx), claimedId: m[1], timestamp: m[2], nonce: m[3], signature: m[4] };
}

function sha256(s: string): string {
    return createHash('sha256').update(s).digest('hex');
}

function hmac(key: Buffer, message: string): string {
    return createHmac('sha256', key).update(message).digest('hex');
}
