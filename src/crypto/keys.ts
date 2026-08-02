// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Key management — generation, storage, rotation via VS Code SecretStorage.
 */

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { KeyMetadata } from './types';

const SECRET_KEY_CURRENT = 'argus.instanceKey';
const SECRET_KEY_PREVIOUS = 'argus.instanceKeyPrevious';
const INSTANCE_ID_KEY = 'argus.instanceId';
const KEY_METADATA_KEY = 'argus.keyMetadata';

export class KeyManager {
    private currentKey: Buffer | null = null;
    private previousKey: Buffer | null = null;
    private _instanceId: string = '';

    constructor(
        private readonly secrets: vscode.SecretStorage,
        private readonly globalState: vscode.Memento,
    ) {}

    /** Initialize keys — generate if first run, load if existing. */
    async initialize(): Promise<void> {
        // Load or generate instance ID
        let id = this.globalState.get<string>(INSTANCE_ID_KEY);
        if (!id) {
            id = randomBytes(8).toString('hex');
            await this.globalState.update(INSTANCE_ID_KEY, id);
        }
        this._instanceId = id;

        // Load or generate current key
        const storedKey = await this.secrets.get(SECRET_KEY_CURRENT);
        if (storedKey) {
            this.currentKey = Buffer.from(storedKey, 'hex');
        } else {
            this.currentKey = randomBytes(32);
            await this.secrets.store(SECRET_KEY_CURRENT, this.currentKey.toString('hex'));
            const metadata: KeyMetadata = {
                keyId: randomBytes(4).toString('hex'),
                createdAt: new Date().toISOString(),
                isActive: true,
            };
            await this.globalState.update(KEY_METADATA_KEY, metadata);
        }

        // Load previous key if it exists (for rotation grace period)
        const storedPrev = await this.secrets.get(SECRET_KEY_PREVIOUS);
        if (storedPrev) {
            this.previousKey = Buffer.from(storedPrev, 'hex');
        }
    }

    get instanceId(): string {
        return this._instanceId;
    }

    /** Get the current signing key. Throws if not initialized. */
    getSigningKey(): Buffer {
        if (!this.currentKey) {
            throw new Error('KeyManager not initialized. Call initialize() first.');
        }
        return this.currentKey;
    }

    /** Get all verification keys (current + previous for rotation grace). */
    getVerificationKeys(): Buffer[] {
        const keys: Buffer[] = [];
        if (this.currentKey) { keys.push(this.currentKey); }
        if (this.previousKey) { keys.push(this.previousKey); }
        return keys;
    }

    /** Rotate the instance key. Old key is kept for grace period verification. */
    async rotateKey(): Promise<void> {
        if (!this.currentKey) {
            throw new Error('KeyManager not initialized.');
        }

        // Move current → previous
        await this.secrets.store(SECRET_KEY_PREVIOUS, this.currentKey.toString('hex'));
        this.previousKey = this.currentKey;

        // Generate new current
        this.currentKey = randomBytes(32);
        await this.secrets.store(SECRET_KEY_CURRENT, this.currentKey.toString('hex'));

        // Update metadata
        const metadata: KeyMetadata = {
            keyId: randomBytes(4).toString('hex'),
            createdAt: new Date().toISOString(),
            isActive: true,
        };
        await this.globalState.update(KEY_METADATA_KEY, metadata);
    }

    /** Get key metadata for display. */
    getMetadata(): KeyMetadata | undefined {
        return this.globalState.get<KeyMetadata>(KEY_METADATA_KEY);
    }

    /** Check if key rotation is recommended based on age. */
    isRotationRecommended(maxAgeDays: number): boolean {
        const meta = this.getMetadata();
        if (!meta) { return true; }
        const age = Date.now() - new Date(meta.createdAt).getTime();
        return age > maxAgeDays * 24 * 60 * 60 * 1000;
    }
}
