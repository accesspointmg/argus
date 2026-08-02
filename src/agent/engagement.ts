// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * EngagementPolicy — decides whether Argus should speak on a thread at all.
 *
 * This replaces the earlier "last word" rule, which asked *did someone comment
 * after me?* and re-engaged whenever the answer was yes. Two agents following
 * that rule alternate forever: Argus comments, Copilot sees a non-Copilot
 * comment last and replies, Argus sees a non-Argus comment last and replies,
 * and so on with no upper bound. `LoopDetector` caps chains of follow-up *PRs*,
 * but nothing capped comment volume inside a single thread.
 *
 * The question here is not "whose turn is it?" but "is there something new that
 * needs saying, and have I already said enough?". Three rules:
 *
 *   Budget      Argus posts at most `maxComments` times per thread (default 3:
 *               an assessment, a response to feedback, a closing note). After
 *               that it goes quiet.
 *
 *   Bots        Argus acknowledges another agent's review once, then stops
 *               engaging with bots on that thread. A human comment re-opens the
 *               conversation; another bot comment does not.
 *
 *   Novelty     A candidate comment that repeats something Argus already posted
 *               is suppressed, so it cannot restate itself in fresh words.
 *
 * An explicit @mention from a human always re-arms engagement, because someone
 * asking Argus a direct question should get an answer even on a spent thread.
 */

import { createHash } from 'crypto';
import type { Comment } from '../forge/types';
import type { StampManager } from '../crypto/stamp';
import type { Logger } from '../util/logger';

// ─── Types ──────────────────────────────────────────────────────

export interface EngagementDecision {
    /** Whether Argus should post on this thread now. */
    engage: boolean;
    /** Human-readable reason, suitable for logging. */
    reason: string;
    /** How many comments Argus has already posted here. */
    ourComments: number;
    /** The configured budget. */
    budget: number;
}

export interface EngagementOptions {
    /** Comments Argus may post per thread before going quiet. */
    maxComments?: number;
    /** Handle that re-arms engagement when a human mentions it. */
    mentionHandle?: string;
}

// ─── Constants ──────────────────────────────────────────────────

/**
 * Default per-thread comment budget.
 *
 * Three covers the useful shape of a conversation — initial assessment, one
 * reply to feedback, one closing note — without producing the endless threads
 * that make an issue unreadable.
 */
const DEFAULT_MAX_COMMENTS = 3;

/** Default handle a human can mention to re-arm engagement. */
const DEFAULT_MENTION_HANDLE = 'argus';

/**
 * Logins ending in this suffix are agents, not people. GitHub appends it to
 * every App-authored account (github-actions[bot], copilot[bot], …).
 */
const BOT_SUFFIX = '[bot]';

/** Where a stamp begins, so it can be excluded from content hashing. */
const STAMP_DELIMITER = '\n\n---\n';

// ─── Policy ─────────────────────────────────────────────────────

export class EngagementPolicy {
    private readonly maxComments: number;
    private readonly mentionHandle: string;

    constructor(
        private readonly stampManager: StampManager,
        private readonly logger: Logger,
        options: EngagementOptions = {},
    ) {
        this.maxComments = options.maxComments ?? DEFAULT_MAX_COMMENTS;
        this.mentionHandle = (options.mentionHandle ?? DEFAULT_MENTION_HANDLE).toLowerCase();
    }

    /**
     * Decide whether to speak, given the thread's comments in any order.
     *
     * Fails open: if the caller could not read comments it should pass an empty
     * array, which is treated as a fresh thread. Staying silent on an error
     * would make Argus look dead; posting twice is the lesser fault.
     */
    decide(comments: Comment[]): EngagementDecision {
        const budget = this.maxComments;

        if (comments.length === 0) {
            return { engage: true, reason: 'No comments yet', ourComments: 0, budget };
        }

        const ordered = [...comments].sort(
            (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        );
        const ours = ordered.filter((c) => this.isOurs(c));
        const ourCount = ours.length;
        const latest = ordered[ordered.length - 1];

        // Nothing has happened since we last spoke.
        if (this.isOurs(latest)) {
            return {
                engage: false,
                reason: 'Our comment is the most recent — nothing new to respond to',
                ourComments: ourCount,
                budget,
            };
        }

        // A human asking directly outranks the budget. Bots cannot summon us,
        // or one could spend our budget on our behalf.
        const lastOurs = ours[ours.length - 1];
        const mentionedByHuman = ordered.some(
            (c) =>
                !this.isBot(c) &&
                !this.isOurs(c) &&
                this.mentionsUs(c) &&
                (!lastOurs || c.createdAt.getTime() > lastOurs.createdAt.getTime()),
        );
        if (mentionedByHuman) {
            return {
                engage: true,
                reason: `Directly mentioned by a human since our last comment`,
                ourComments: ourCount,
                budget,
            };
        }

        if (ourCount >= budget) {
            return {
                engage: false,
                reason: `Comment budget spent (${ourCount}/${budget}) — staying quiet unless @${this.mentionHandle} is mentioned`,
                ourComments: ourCount,
                budget,
            };
        }

        // Another agent spoke last. Acknowledge one bot review per thread, then
        // leave it alone: replying again is how the alternating loop starts.
        if (this.isBot(latest)) {
            if (this.hasRepliedToBot(ordered)) {
                return {
                    engage: false,
                    reason: 'Already responded to an agent on this thread — not replying to bots again',
                    ourComments: ourCount,
                    budget,
                };
            }
            return {
                engage: true,
                reason: `Responding once to ${latest.author}`,
                ourComments: ourCount,
                budget,
            };
        }

        return {
            engage: true,
            reason: `New comment from ${latest.author}`,
            ourComments: ourCount,
            budget,
        };
    }

    /**
     * Whether a candidate body repeats something we already posted.
     *
     * Stamps are stripped before hashing: each carries a fresh timestamp and
     * nonce, so hashing a stamped body would never match anything.
     */
    isDuplicate(candidate: string, comments: Comment[]): boolean {
        const target = this.contentHash(candidate);
        for (const c of comments) {
            if (!this.isOurs(c)) {
                continue;
            }
            if (this.contentHash(c.body) === target) {
                this.logger.debug(`Suppressing duplicate comment (hash ${target.substring(0, 12)})`);
                return true;
            }
        }
        return false;
    }

    // ─── Internals ──────────────────────────────────────────────

    /** Hash a comment's substance, ignoring the stamp and incidental whitespace. */
    private contentHash(body: string): string {
        const idx = body.lastIndexOf(STAMP_DELIMITER);
        const content = idx === -1 ? body : body.substring(0, idx);
        const normalized = content.replace(/\s+/g, ' ').trim().toLowerCase();
        return createHash('sha256').update(normalized).digest('hex');
    }

    /** Whether a comment was posted by this Argus instance. */
    private isOurs(comment: Comment): boolean {
        const shortId = this.stampManager.extractInstanceId(comment.body);
        return shortId !== null && this.stampManager.instanceId.startsWith(shortId);
    }

    /**
     * Whether a comment came from *another* agent rather than a person.
     *
     * Our own comments are never agents here, even though Argus posts from a
     * bot account whose login ends in the same suffix. Missing that check made
     * `hasRepliedToBot` blind to our own replies, so the bot loop this class
     * exists to prevent would have continued unchecked.
     *
     * A stamped comment from a *different* Argus instance does count: two
     * instances watching one repo should not talk to each other either.
     */
    private isBot(comment: Comment): boolean {
        if (this.isOurs(comment)) {
            return false;
        }
        if (comment.author.toLowerCase().endsWith(BOT_SUFFIX)) {
            return true;
        }
        return this.stampManager.hasStamp(comment.body);
    }

    /** Whether the comment mentions our handle. */
    private mentionsUs(comment: Comment): boolean {
        const pattern = new RegExp(`(^|\\s)@${this.mentionHandle}\\b`, 'i');
        return pattern.test(comment.body);
    }

    /** Whether any of our comments came after an agent's, i.e. we already replied to one. */
    private hasRepliedToBot(ordered: Comment[]): boolean {
        let sawBot = false;
        for (const c of ordered) {
            if (this.isBot(c)) {
                sawBot = true;
            } else if (sawBot && this.isOurs(c)) {
                return true;
            }
        }
        return false;
    }
}
