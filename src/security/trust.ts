// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Trust manager — graduated trust from repo role, interaction history, and
 * Argus's own moderation record.
 *
 * Tiers (base score):
 *   owner 1.0 · maintainer 0.85 · reviewer 0.75 · contributor 0.5 · participant 0.3 · unknown 0
 *
 * Settings (read live):
 *   argus.trust.trustedUsers              → owner tier (immune, trusted for code generation)
 *   argus.trust.treatMaintainersAsTrusted → maintainers trusted for code gen; never blocked/reported
 *   argus.trust.treatReviewersAsTrusted   → same for write-access reviewers
 *   argus.trust.newAccountSuspicionDays   → young accounts get a trust penalty
 *   argus.trust.historyWeight             → multiplier on the history modifier
 *
 * Flags/blocks Argus records are persisted per repo per user in a Memento.
 * Forge lookups are cached (role 10 min, history 1 h) and history lookups are
 * capped per minute because GitHub's search API allows 30 requests/min.
 */

import type * as vscode from 'vscode';
import type { Forge, RepoRole, UserHistory } from '../forge/types';
import { TrustTier, UserTrustProfile, BASE_TRUST_SCORES } from './types';
import { readSetting, type SettingReader } from './settings';
import type { Logger } from '../util/logger';

const HISTORY_STATE_KEY = 'argus.trust.history';
const MAX_HISTORY_RECORDS = 5000;
const ROLE_TTL_MS = 10 * 60 * 1000;
const HISTORY_TTL_MS = 60 * 60 * 1000;
/** Each getUserHistory costs up to 2 GitHub search calls; keep well under 30/min. */
const MAX_HISTORY_FETCHES_PER_MINUTE = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Associations that can never have write access — skip the role lookup. */
const OUTSIDER_ASSOCIATIONS = new Set(['NONE', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'CONTRIBUTOR', 'MANNEQUIN']);

interface ModerationRecord {
    flags: number;
    blocks: number;
    lastAt: string;
}

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
        default:
            return 'unknown';
    }
}

/** History modifier in [-0.3, +0.2] before weighting. */
export function computeHistoryModifier(history: UserHistory): number {
    let modifier = 0;
    modifier += Math.min(history.mergedPRs * 0.02, 0.1);
    modifier += Math.min(history.closedIssuesAsValid * 0.01, 0.05);
    if (history.totalComments > 20) { modifier += 0.02; }
    if (history.totalComments > 100) { modifier += 0.03; }
    modifier -= Math.min(history.previousFlags * 0.05, 0.15);
    modifier -= Math.min(history.previousBlocks * 0.15, 0.3);
    return Math.max(-0.3, Math.min(0.2, modifier));
}

export class TrustManager {
    private roleCache = new Map<string, { role: RepoRole; expiresAt: number }>();
    private historyCache = new Map<string, { history: UserHistory; expiresAt: number }>();
    private historyFetches: number[] = [];

    constructor(
        private readonly state: vscode.Memento,
        private readonly logger?: Logger,
        private readonly settings: SettingReader = readSetting,
        private readonly now: () => number = Date.now,
    ) {}

    // ─── Public API ─────────────────────────────────────────────

    /** Full trust profile (role + forge history + Argus's moderation record). */
    async resolve(forge: Forge, username: string, association?: string): Promise<UserTrustProfile> {
        const repo = repoKeyOf(forge);
        const [role, forgeHistory] = await Promise.all([
            this.getRole(forge, username, association),
            this.getForgeHistory(forge, username),
        ]);
        const local = this.getModerationRecord(repo, username);

        const tier: TrustTier = this.isConfiguredTrusted(username) ? 'owner' : roleToTier(role);
        const baseTrustScore = BASE_TRUST_SCORES[tier];

        const history: UserHistory = {
            ...forgeHistory,
            previousFlags: local.flags,
            previousBlocks: local.blocks,
        };

        const weight = Math.max(0, this.settings('trust.historyWeight', 1));
        let historyModifier = computeHistoryModifier(history) * weight;

        const youngDays = this.settings('trust.newAccountSuspicionDays', 30);
        if (youngDays > 0 && history.accountCreatedAt && BASE_TRUST_SCORES[tier] < BASE_TRUST_SCORES.reviewer) {
            const ageDays = (this.now() - new Date(history.accountCreatedAt).getTime()) / DAY_MS;
            if (ageDays < youngDays) { historyModifier -= 0.2; }
        }

        const effectiveTrustScore = tier === 'owner'
            ? 1
            : Math.max(0, Math.min(1, baseTrustScore + historyModifier));

        return {
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
            lastUpdated: new Date(this.now()),
        };
    }

    /**
     * May this user's request reach the coder? Role-based only — merged-PR
     * history never grants it. Costs at most one cached REST call, none for
     * outsiders identified by `association`.
     */
    async isTrustedForCodeGen(forge: Forge, username: string, association?: string): Promise<boolean> {
        if (this.isConfiguredTrusted(username)) { return true; }
        const role = await this.getRole(forge, username, association);
        return this.isProtectedTier(roleToTier(role));
    }

    /** Write access or better (used to vet stamps claiming another Argus instance). */
    async hasWriteAccess(forge: Forge, username: string, association?: string): Promise<boolean> {
        const role = await this.getRole(forge, username, association);
        return role === 'owner' || role === 'admin' || role === 'maintainer' || role === 'write';
    }

    /** Owners and configured trusted users are immune to all moderation. */
    isImmune(profile: UserTrustProfile): boolean {
        return profile.tier === 'owner';
    }

    /** @deprecated use {@link isImmune}. */
    isOwnerImmune(profile: UserTrustProfile): boolean {
        return this.isImmune(profile);
    }

    /**
     * Never block or report this user — owners, and maintainers/reviewers when
     * the corresponding `treat…AsTrusted` setting is on. They may still be flagged.
     */
    isProtectedFromBlock(profile: UserTrustProfile): boolean {
        return this.isProtectedTier(profile.tier);
    }

    async recordFlag(forge: Forge | string, username: string): Promise<void> {
        await this.bump(typeof forge === 'string' ? forge : repoKeyOf(forge), username, 'flags');
    }

    async recordBlock(forge: Forge | string, username: string): Promise<void> {
        await this.bump(typeof forge === 'string' ? forge : repoKeyOf(forge), username, 'blocks');
    }

    getModerationRecord(repo: string, username: string): { flags: number; blocks: number } {
        const rec = this.records()[recordKey(repo, username)];
        return { flags: rec?.flags ?? 0, blocks: rec?.blocks ?? 0 };
    }

    /** Drop cached forge lookups for a user. */
    invalidate(username: string): void {
        const suffix = `:${username.toLowerCase()}`;
        for (const m of [this.roleCache, this.historyCache] as Map<string, unknown>[]) {
            for (const key of [...m.keys()]) {
                if (key.endsWith(suffix)) { m.delete(key); }
            }
        }
    }

    clearCache(): void {
        this.roleCache.clear();
        this.historyCache.clear();
    }

    /** Clear caches AND the persisted moderation record (the "Reset trust data" command). */
    async reset(): Promise<void> {
        this.clearCache();
        await this.state.update(HISTORY_STATE_KEY, undefined);
    }

    // ─── Internals ──────────────────────────────────────────────

    private isProtectedTier(tier: TrustTier): boolean {
        if (tier === 'owner') { return true; }
        if (tier === 'maintainer') { return this.settings('trust.treatMaintainersAsTrusted', true); }
        if (tier === 'reviewer') { return this.settings('trust.treatReviewersAsTrusted', true); }
        return false;
    }

    private isConfiguredTrusted(username: string): boolean {
        const list = this.settings<unknown[]>('trust.trustedUsers', []);
        const u = username.toLowerCase();
        return list.some((x) => typeof x === 'string' && x.trim().toLowerCase() === u);
    }

    private async getRole(forge: Forge, username: string, association?: string): Promise<RepoRole> {
        if (association && OUTSIDER_ASSOCIATIONS.has(association.toUpperCase()) && forge.platform === 'github') {
            return 'none';
        }
        const key = `${repoKeyOf(forge)}:${username.toLowerCase()}`;
        const hit = this.roleCache.get(key);
        if (hit && hit.expiresAt > this.now()) { return hit.role; }
        let role: RepoRole;
        try {
            role = await forge.getUserRole(username);
        } catch (err) {
            this.logger?.warn(`Role lookup failed for ${username}: ${err instanceof Error ? err.name : 'error'} — treating as no access`);
            return 'none'; // fail closed, don't cache the failure
        }
        this.roleCache.set(key, { role, expiresAt: this.now() + ROLE_TTL_MS });
        return role;
    }

    private async getForgeHistory(forge: Forge, username: string): Promise<UserHistory> {
        const key = `${repoKeyOf(forge)}:${username.toLowerCase()}`;
        const hit = this.historyCache.get(key);
        const t = this.now();
        if (hit && hit.expiresAt > t) { return hit.history; }

        this.historyFetches = this.historyFetches.filter((x) => t - x < 60_000);
        if (this.historyFetches.length >= MAX_HISTORY_FETCHES_PER_MINUTE) {
            // Over budget: a stale entry beats nothing; nothing means no history credit.
            return hit?.history ?? emptyHistory();
        }
        this.historyFetches.push(t);

        try {
            const history = await forge.getUserHistory(username);
            this.historyCache.set(key, { history, expiresAt: t + HISTORY_TTL_MS });
            return history;
        } catch {
            return hit?.history ?? emptyHistory();
        }
    }

    private records(): Record<string, ModerationRecord> {
        return this.state.get<Record<string, ModerationRecord>>(HISTORY_STATE_KEY) ?? {};
    }

    private async bump(repo: string, username: string, field: 'flags' | 'blocks'): Promise<void> {
        const all = { ...this.records() };
        const key = recordKey(repo, username);
        const rec = all[key] ?? { flags: 0, blocks: 0, lastAt: '' };
        all[key] = { ...rec, [field]: rec[field] + 1, lastAt: new Date(this.now()).toISOString() };

        const keys = Object.keys(all);
        if (keys.length > MAX_HISTORY_RECORDS) {
            keys.sort((a, b) => all[a].lastAt.localeCompare(all[b].lastAt));
            for (const k of keys.slice(0, keys.length - MAX_HISTORY_RECORDS)) { delete all[k]; }
        }
        await this.state.update(HISTORY_STATE_KEY, all);
    }
}

/** @deprecated renamed to {@link TrustManager}. */
export { TrustManager as TrustResolver };

function repoKeyOf(forge: Forge): string {
    return `${forge.platform}:${forge.owner}/${forge.repo}`.toLowerCase();
}

function recordKey(repo: string, username: string): string {
    return `${repo.toLowerCase()}|${username.toLowerCase()}`;
}

function emptyHistory(): UserHistory {
    return { mergedPRs: 0, closedIssuesAsValid: 0, previousFlags: 0, previousBlocks: 0, totalComments: 0 };
}
