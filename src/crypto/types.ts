// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Cryptographic stamp types — HMAC-SHA256 identity, nonce registry, keys.
 */

/** A cryptographic stamp attached to every Argus-produced artifact. */
export interface ArgusStamp {
    instanceId: string;    // Public: e.g., "a3f8c912e4b7d601"
    version: string;       // Extension version: "0.1.0"
    timestamp: string;     // ISO 8601
    nonce: string;         // Random 64-bit hex
    contentHash: string;   // SHA-256 of the content preceding the stamp
    signature: string;     // HMAC-SHA256(secret, instanceId|timestamp|nonce|contentHash)
}

/** Result of verifying a stamp. */
export interface StampVerification {
    valid: boolean;
    reason?: string;
    stamp?: ArgusStamp;
    isOurInstance: boolean;
    tampered: boolean;
    replayed: boolean;
}

/** An entry in the nonce anti-replay registry. */
export interface NonceEntry {
    nonce: string;
    timestamp: string;
    repo: string;
    commentId: string;
    action: string;
}

/** Key metadata for rotation tracking. */
export interface KeyMetadata {
    keyId: string;
    createdAt: string;
    rotatedAt?: string;
    expiresAt?: string;
    isActive: boolean;
}
