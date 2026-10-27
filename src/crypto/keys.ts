// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Key management — generation, storage, rotation via VS Code SecretStorage.
 *
 * The current key signs. Retired keys are kept (bounded, newest first, by key
 * id) so stamps and audit entries signed before a rotation still verify.
 */

import type * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { KeyMetadata } from './types';
import { readSetting, type SettingReader } from '../security/settings';

const SECRET_KEY_CURRENT = 'argus.instanceKey';
const SECRET_KEY_PREVIOUS_LEGACY = 'argus.instanceKeyPrevious';
const SECRET_KEYRING = 'argus.instanceKeyring';
const INSTANCE_ID_KEY = 'argus.instanceId';
const KEY_METADATA_KEY = 'argus.keyMetadata';

/** How many retired keys to keep. At the 90-day default that's five years. */
export const MAX_RETIRED_KEYS = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

interface StoredKey {
    keyId: string;
    key: string;        // hex
    createdAt: string;
    retiredAt: string;
}

export interface VerificationKey {
    keyId: string;
    key: Buffer;
}

export class KeyManager {
    private currentKey: Buffer | null = null;
    private currentMeta: KeyMetadata | null = null;
    private retired: { keyId: string; key: Buffer; createdAt: string; retiredAt: string }[] = [];
    private _instanceId = '';

    constructor(
        private readonly secrets: vscode.SecretStorage,
        private readonly globalState: vscode.Memento,
        private readonly settings: SettingReader = readSetting,
    ) {}

    /** Initialize keys — generate if first run, load if existing. */
    async initialize(): Promise<void> {
        let id = this.globalState.get<string>(INSTANCE_ID_KEY);
        if (!id || !/^[a-f0-9]{16}$/.test(id)) {
            id = randomBytes(8).toString('hex');
            await this.globalState.update(INSTANCE_ID_KEY, id);
        }
        this._instanceId = id;

        const storedKey = await this.secrets.get(SECRET_KEY_CURRENT);
        let meta = this.globalState.get<KeyMetadata>(KEY_METADATA_KEY);
        if (storedKey) {
            this.currentKey = Buffer.from(storedKey, 'hex');
            if (!meta) {
                // Key predates metadata: give it an id, treat its age as unknown (now).
                meta = { keyId: newKeyId(), createdAt: new Date().toISOString(), isActive: true };
                await this.globalState.update(KEY_METADATA_KEY, meta);
            }
        } else {
            this.currentKey = randomBytes(32);
            await this.secrets.store(SECRET_KEY_CURRENT, this.currentKey.toString('hex'));
            meta = { keyId: newKeyId(), createdAt: new Date().toISOString(), isActive: true };
            await this.globalState.update(KEY_METADATA_KEY, meta);
        }
        this.currentMeta = meta;

        // Keyring of retired keys
        const ring = parseRing(await this.secrets.get(SECRET_KEYRING));
        // Migrate the single legacy "previous" key into the ring
        const legacy = await this.secrets.get(SECRET_KEY_PREVIOUS_LEGACY);
        if (legacy && !ring.some((k) => k.key === legacy)) {
            ring.push({ keyId: 'legacy', key: legacy, createdAt: '', retiredAt: '' });
        }
        this.retired = ring.map((k) => ({ ...k, key: Buffer.from(k.key, 'hex') }));
        if (legacy) {
            await this.persistRing();
            await this.secrets.delete(SECRET_KEY_PREVIOUS_LEGACY);
        }
    }

    get instanceId(): string {
        return this._instanceId;
    }

    /** Id of the key currently used for signing. */
    get currentKeyId(): string {
        return this.currentMeta?.keyId ?? '';
    }

    /** Get the current signing key. Throws if not initialized. */
    getSigningKey(): Buffer {
        if (!this.currentKey) {
            throw new Error('KeyManager not initialized. Call initialize() first.');
        }
        return this.currentKey;
    }

    /** All keys that may verify a signature: current first, then retired newest-first. */
    getVerificationKeyring(): VerificationKey[] {
        const out: VerificationKey[] = [];
        if (this.currentKey) { out.push({ keyId: this.currentKeyId, key: this.currentKey }); }
        for (const k of this.retired) { out.push({ keyId: k.keyId, key: k.key }); }
        return out;
    }

    /** All verification keys (current + retired). */
    getVerificationKeys(): Buffer[] {
        return this.getVerificationKeyring().map((k) => k.key);
    }

    /** A specific key by id, current or retired. */
    getKey(keyId: string): Buffer | undefined {
        return this.getVerificationKeyring().find((k) => k.keyId === keyId)?.key;
    }

    /** Rotate: current key joins the keyring (bounded), a fresh key signs from now on. */
    async rotateKey(): Promise<void> {
        if (!this.currentKey || !this.currentMeta) {
            throw new Error('KeyManager not initialized.');
        }
        const now = new Date().toISOString();
        this.retired.unshift({
            keyId: this.currentMeta.keyId,
            key: this.currentKey,
            createdAt: this.currentMeta.createdAt,
            retiredAt: now,
        });
        this.retired = this.retired.slice(0, MAX_RETIRED_KEYS);
        await this.persistRing();

        this.currentKey = randomBytes(32);
        await this.secrets.store(SECRET_KEY_CURRENT, this.currentKey.toString('hex'));

        this.currentMeta = { keyId: newKeyId(), createdAt: now, rotatedAt: now, isActive: true };
        await this.globalState.update(KEY_METADATA_KEY, this.currentMeta);
    }

    /**
     * Rotate if the current key is older than `argus.crypto.keyRotationDays`
     * (0 or less disables). Call on activation and periodically.
     * @returns true when a rotation happened.
     */
    async rotateIfDue(): Promise<boolean> {
        const days = this.settings('crypto.keyRotationDays', 90);
        if (!(days > 0) || !this.isRotationRecommended(days)) { return false; }
        await this.rotateKey();
        return true;
    }

    /** Get key metadata for display. */
    getMetadata(): KeyMetadata | undefined {
        return this.currentMeta ?? this.globalState.get<KeyMetadata>(KEY_METADATA_KEY);
    }

    /** Number of retired keys still accepted for verification. */
    get retiredKeyCount(): number {
        return this.retired.length;
    }

    /** Check if key rotation is recommended based on age. */
    isRotationRecommended(maxAgeDays: number): boolean {
        const meta = this.getMetadata();
        if (!meta) { return true; }
        const created = new Date(meta.createdAt).getTime();
        if (!Number.isFinite(created)) { return true; }
        return Date.now() - created > maxAgeDays * DAY_MS;
    }

    private async persistRing(): Promise<void> {
        const ring: StoredKey[] = this.retired.map((k) => ({
            keyId: k.keyId,
            key: k.key.toString('hex'),
            createdAt: k.createdAt,
            retiredAt: k.retiredAt,
        }));
        await this.secrets.store(SECRET_KEYRING, JSON.stringify(ring));
    }
}

function newKeyId(): string {
    return randomBytes(4).toString('hex');
}

function parseRing(raw: string | undefined): StoredKey[] {
    if (!raw) { return []; }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) { return []; }
        return parsed.filter((k): k is StoredKey =>
            !!k && typeof k.keyId === 'string' && typeof k.key === 'string' && /^[a-f0-9]{64}$/.test(k.key),
        ).slice(0, MAX_RETIRED_KEYS);
    } catch {
        return [];
    }
}
