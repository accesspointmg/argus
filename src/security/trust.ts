// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Trust resolver — graduated trust model based on repo roles and interaction history.
 *
 * Trust tiers:
 *   owner       → 1.0   (immune to block/report; used for testing)
 *   maintainer  → 0.85
 *   reviewer    → 0.75
 *   contributor → 0.50
 *   participant → 0.30
 *   unknown     → 0.00
 *
 * A history modifier adjusts base trust by [-0.3, +0.2] based on past behavior.
 */

import type { Forge, RepoRole, UserHistory } from '../forge/types';
import {
    TrustTier,
    UserTrustProfile,
    BASE_TRUST_SCORES,
} from './types';

/** Map forge-level role strings to TrustTier. */
function roleToTier(role: RepoRole): TrustTier {
    switch (role) {
        case 'admin':
        case 'owner':
            return 'owner';
        case 'maintainer':
            return 'maintainer';
        case 'write':
            return 'reviewer';
        case 'triage':
            return 'contributor';
        case 'read':
            return 'participant';
        case 'none':
        default:
            return 'unknown';
    }
}

/**
 * Compute a history modifier in [-0.3, +0.2] based on past activity.
 *
 * Positive signals: merged PRs, valid closed issues
 * Negative signals: previous flags, blocks
 */
function computeHistoryModifier(history: UserHistory): number {
    let modifier = 0;

    // Positive: merged PRs contribute +0.02 each, capped at +0.1
    modifier += Math.min(history.mergedPRs * 0.02, 0.1);

    // Positive: issues that were closed as valid contribute +0.01 each, capped at +0.05
    modifier += Math.min(history.closedIssuesAsValid * 0.01, 0.05);

    // Positive: general comment volume (indicates engagement), diminishing returns
    if (history.totalComments > 20) { modifier += 0.02; }
    if (history.totalComments > 100) { modifier += 0.03; }

    // Negative: previous flags (each worth -0.05, up to -0.15)
    modifier -= Math.min(history.previousFlags * 0.05, 0.15);

    // Negative: previous blocks are severe (-0.15 each, up to -0.3)
    modifier -= Math.min(history.previousBlocks * 0.15, 0.3);

    // Clamp to [-0.3, +0.2]
    return Math.max(-0.3, Math.min(0.2, modifier));
}

export class TrustResolver {
    /** In-memory cache of resolved profiles. key = "forge:owner/repo:username" */
    private cache = new Map<string, { profile: UserTrustProfile; expiresAt: number }>();
    private cacheTTLMs = 10 * 60 * 1000; // 10 minutes

    /**
     * Resolve the trust profile for a user in a specific repo.
     * Uses caching to avoid excessive API calls.
     */
    async resolve(
        forge: Forge,
        username: string,
    ): Promise<UserTrustProfile> {
        const cacheKey = `${forge.platform}:${forge.owner}/${forge.repo}:${username}`;
        const cached = this.cache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.profile;
        }

        // Fetch role and history from the forge API (owner/repo are on the forge instance)
        const [role, history] = await Promise.all([
            forge.getUserRole(username),
            forge.getUserHistory(username),
        ]);

        const tier = roleToTier(role);
        const baseTrustScore = BASE_TRUST_SCORES[tier];
        const historyModifier = computeHistoryModifier(history);
        const effectiveTrustScore = Math.max(0, Math.min(1, baseTrustScore + historyModifier));

        const profile: UserTrustProfile = {
            username,
            tier,
            baseTrustScore,
            historyModifier,
            effectiveTrustScore,
            repoRole: role,
            history: {
                mergedPRs: history.mergedPRs,
                closedIssuesAsValid: history.closedIssuesAsValid,
                previousFlags: history.previousFlags,
                previousBlocks: history.previousBlocks,
                totalComments: history.totalComments,
                accountAge: history.accountCreatedAt,
            },
            lastUpdated: new Date(),
        };

        this.cache.set(cacheKey, { profile, expiresAt: Date.now() + this.cacheTTLMs });
        return profile;
    }

    /**
     * Check whether a user is the owner (and therefore immune to blocking/reporting).
     */
    isOwnerImmune(profile: UserTrustProfile): boolean {
        return profile.tier === 'owner';
    }

    /**
     * Force-invalidate cache for a user across all repos.
     */
    invalidate(username: string): void {
        for (const key of this.cache.keys()) {
            if (key.endsWith(`:${username}`)) {
                this.cache.delete(key);
            }
        }
    }

    /**
     * Clear the entire cache.
     */
    clearCache(): void {
        this.cache.clear();
    }
}
