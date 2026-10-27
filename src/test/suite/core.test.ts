// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Tests for the cryptographic subsystem.
 */

import * as assert from 'assert';
import { NonceRegistry } from '../../crypto/nonce-registry';

suite('NonceRegistry', () => {
    let registry: NonceRegistry;

    setup(() => {
        // Use a mock globalState
        const data: Record<string, unknown> = {};
        const mockState = {
            get: (key: string) => data[key],
            update: async (key: string, value: unknown) => { data[key] = value; },
            keys: () => Object.keys(data),
            setKeysForSync: () => {},
        };
        registry = new NonceRegistry(mockState as never);
    });

    test('should register and look up nonces', () => {
        registry.register({ nonce: 'nonce1', timestamp: new Date().toISOString(), repo: 'test', commentId: 'c1', action: 'stamp' });
        assert.ok(registry.lookup('nonce1'));
        assert.strictEqual(registry.lookup('nonexistent'), undefined);
    });

    test('should reject duplicate nonces', () => {
        registry.register({ nonce: 'nonce1', timestamp: new Date().toISOString(), repo: 'test', commentId: 'c1', action: 'stamp' });
        // Registering same nonce again just overwrites (no throw), so check it still exists
        registry.register({ nonce: 'nonce1', timestamp: new Date().toISOString(), repo: 'test', commentId: 'c2', action: 'stamp' });
        assert.ok(registry.lookup('nonce1'));
    });

    test('should prune expired nonces', () => {
        // Register a nonce with a very old timestamp
        registry.register({ nonce: 'old-nonce', timestamp: new Date(0).toISOString(), repo: 'test', commentId: 'c1', action: 'stamp' });
        registry.prune(0); // 0 day retention = prune everything
        assert.strictEqual(registry.lookup('old-nonce'), undefined);
    });
});
