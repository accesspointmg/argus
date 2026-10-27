// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Multi-instance sovereignty — an Argus instance doesn't act on an issue or
 * PR that another Argus instance already owns.
 *
 * We can verify our own stamps (we hold the key) but not another instance's.
 * A foreign stamp therefore counts only when posted by an account with write
 * access to the repo — which a real Argus instance needs anyway to push its
 * branches, and which a drive-by attacker doesn't have. A forged foreign
 * stamp from an outsider is ignored, so it can't be used to make Argus back
 * off. Deference only ever suppresses Argus's own discretionary work (coding,
 * engaging); it never skips security gates like the PR gatekeeper.
 */

import type { Forge } from '../forge/types';
import type { StampManager } from '../crypto/stamp';
import type { TrustManager } from './trust';

export interface StampedItem {
    body: string;
    author: string;
    authorAssociation?: string;
    /** Artifact id for replay binding (comment id, `pr:<n>`, `issue:<n>`). */
    id?: string;
}

export type Ownership =
    | { owner: 'self' }
    | { owner: 'other'; instanceId: string; author: string }
    | { owner: 'none' };

/**
 * Decide who owns a thread. `items` should be chronological (issue/PR body
 * first, then comments); the first authentic claim wins.
 */
export async function resolveOwnership(
    forge: Forge,
    stamps: StampManager,
    trust: TrustManager,
    items: readonly StampedItem[],
): Promise<Ownership> {
    for (const item of items) {
        if (!item.body) { continue; }
        if (stamps.isOwnAuthentic(item.body, item.id)) { return { owner: 'self' }; }

        const claimed = stamps.claimedInstanceId(item.body);
        if (!claimed || stamps.instanceId.startsWith(claimed)) { continue; } // none, or a failed copy of ours
        if (await trust.hasWriteAccess(forge, item.author, item.authorAssociation)) {
            return { owner: 'other', instanceId: claimed, author: item.author };
        }
    }
    return { owner: 'none' };
}
