// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Comment handler — moderation for comments on issues/PRs.
 *
 * Escalation ladder (settings read live):
 *   flag   — any suspicion: regex pre-filter hits, model "suspicious", or the
 *            classifier being unavailable. Logged and surfaced; nothing is
 *            done on the forge.
 *   delete — model-confirmed "hostile" at ≥ trust-adjusted
 *            `security.threatThreshold`, and `security.deleteHostileComments`.
 *   block  — model-confirmed "hostile" at ≥ trust-adjusted
 *            `security.blockThreshold`, `security.autoBlock` (default off),
 *            author not protected by trust settings, and within
 *            `rateLimits.blocksPerDay` (enforced by the guarded forge).
 *   report — only after a successful block, when `security.reportOnBlock`.
 *
 * Regex alone never deletes or blocks. Hostile text is never echoed: reasons
 * and audit details carry only categories and numbers.
 */

import type { Forge, Comment } from '../forge/types';
import type { CommentEvaluation, TrackedIssue } from './types';
import type { Logger } from '../util/logger';
import type { Sanitizer } from '../security/sanitizer';
import type { ThreatClassifier } from '../security/threat-classifier';
import type { TrustManager } from '../security/trust';
import { artifactId, type StampManager } from '../crypto/stamp';
import type { AuditLog } from '../crypto/audit';
import type { ThreatAssessment, UserTrustProfile } from '../security/types';
import { computeThresholds } from '../security/types';
import { hasManipulationPatterns } from '../security/sanitizer';
import { readSetting, type SettingReader } from '../security/settings';
import { HaltedError, UnsupportedError, ForgeRateLimitError } from '../forge/errors';

export type ModerationAction = 'flag' | 'delete' | 'block' | 'report' | 'update_pr' | 'none';
export type ModerationOutcome = 'flagged' | 'deleted' | 'blocked' | 'reported';

export interface CommentAction {
    commentId: string;
    author: string;
    evaluation?: CommentEvaluation;
    threatClassification: 'clean' | 'suspicious' | 'hostile';
    /** Actions decided. */
    actions: ModerationAction[];
    /** Actions that actually succeeded on the forge (empty in dry run's stubs only if the forge threw). */
    actionsTaken: ModerationOutcome[];
    /** Categories and numbers only — safe to show or post. */
    reason: string;
    /** A human should look (classifier unavailable, or an action was withheld/failed). */
    needsHumanReview: boolean;
}

export class CommentHandler {
    constructor(
        private readonly logger: Logger,
        private readonly sanitizer: Sanitizer,
        private readonly threatClassifier: ThreatClassifier,
        private readonly trust: TrustManager,
        private readonly auditLog: AuditLog,
        /** Optional defensive skip of authentic Argus comments (callers filter them already). */
        private readonly stampManager?: StampManager,
        private readonly settings: SettingReader = readSetting,
    ) {}

    /** Moderate comments. A failure on one comment marks it suspicious, never clean. */
    async processComments(forge: Forge, issue: TrackedIssue, comments: Comment[]): Promise<CommentAction[]> {
        const results: CommentAction[] = [];
        for (const comment of comments) {
            try {
                const action = await this.decide(forge, issue, comment);
                await this.execute(forge, action);
                results.push(action);
            } catch (err) {
                if (err instanceof HaltedError) { throw err; }
                this.logger.error(`Failed processing comment ${comment.id}: ${err instanceof Error ? err.name : 'error'}`);
                results.push({
                    commentId: comment.id,
                    author: comment.author,
                    threatClassification: 'suspicious',
                    actions: ['flag'],
                    actionsTaken: [],
                    reason: 'Moderation failed — needs human review',
                    needsHumanReview: true,
                });
            }
        }
        return results;
    }

    /** Pure decision for one comment (no forge writes). */
    async decide(forge: Forge, issue: TrackedIssue, comment: Comment): Promise<CommentAction> {
        const base = { commentId: comment.id, author: comment.author, actionsTaken: [] as ModerationOutcome[] };

        if (this.stampManager?.isOwnAuthentic(comment.body, artifactId(`${forge.platform}:${forge.owner}/${forge.repo}`, 'comment', comment.id))) {
            return { ...base, threatClassification: 'clean', actions: ['none'], reason: 'Authentic Argus comment', needsHumanReview: false };
        }

        const trust = await this.trust.resolve(forge, comment.author, comment.authorAssociation);
        if (this.trust.isImmune(trust)) {
            return { ...base, threatClassification: 'clean', actions: ['none'], reason: 'Trusted user — immune from moderation', needsHumanReview: false };
        }

        const sanitized = this.sanitizer.sanitize(comment.body);
        const threat = await this.threatClassifier.classify(sanitized, comment.author, `comment on #${issue.issueNumber}`);
        const actions = this.chooseActions(threat, trust, hasManipulationPatterns(sanitized.strippedPatterns));

        const classification: CommentAction['threatClassification'] =
            actions.includes('none') ? 'clean' : threat.classification === 'hostile' && threat.llmConfirmed ? 'hostile' : 'suspicious';

        const reason = [
            classification === 'clean' ? 'Clean' : `${classification}${threat.threatType ? ` (${threat.threatType})` : ''}`,
            `confidence ${(threat.confidence * 100).toFixed(0)}%`,
            `trust ${(trust.effectiveTrustScore * 100).toFixed(0)}%`,
            threat.llmConfirmed ? 'model-confirmed' : 'not model-confirmed',
        ].join(', ');

        return {
            ...base,
            threatClassification: classification,
            actions,
            reason,
            needsHumanReview: threat.needsHumanReview || (classification !== 'clean' && !threat.llmConfirmed),
        };
    }

    /** The escalation ladder. Pure. */
    chooseActions(threat: ThreatAssessment, trust: UserTrustProfile, prefilterHit: boolean): ModerationAction[] {
        const thresholds = computeThresholds(trust.effectiveTrustScore, {
            threat: this.settings('security.threatThreshold', 0.5),
            block: this.settings('security.blockThreshold', 0.8),
        });

        if (!threat.llmConfirmed) {
            // Regex hits and classifier failures: flag at most.
            return threat.classification === 'clean' && !prefilterHit ? ['none'] : ['flag'];
        }

        if (threat.classification === 'clean') {
            return prefilterHit ? ['flag'] : ['none'];
        }

        const actions: ModerationAction[] = ['flag'];
        if (threat.classification !== 'hostile' || threat.confidence < thresholds.flagThreshold) {
            return actions;
        }

        if (this.settings('security.deleteHostileComments', true)) {
            actions.push('delete');
        }
        if (
            threat.confidence >= thresholds.blockThreshold &&
            this.settings('security.autoBlock', false) &&
            !this.trust.isProtectedFromBlock(trust)
        ) {
            actions.push('block');
            if (this.settings('security.reportOnBlock', false)) { actions.push('report'); }
        }
        return actions;
    }

    /** Carry out decided actions; successes go to `action.actionsTaken`. */
    private async execute(forge: Forge, action: CommentAction): Promise<void> {
        const repo = `${forge.owner}/${forge.repo}`;
        const done: ModerationOutcome[] = [];
        let blocked = false;
        // Only model-confirmed flags count against the user's trust history.
        const confirmed = !action.needsHumanReview;

        for (const act of action.actions) {
            try {
                switch (act) {
                    case 'flag':
                        if (confirmed) { await this.trust.recordFlag(forge, action.author); }
                        await this.audit(repo, 'flag_comment', action, `Flagged comment by ${action.author}`);
                        this.logger.info(`Flagged comment ${action.commentId} by ${action.author}: ${action.reason}`);
                        done.push('flagged');
                        break;

                    case 'delete':
                        await forge.deleteComment(action.commentId);
                        await this.audit(repo, 'delete_comment', action, `Deleted comment by ${action.author}`);
                        this.logger.info(`Deleted comment ${action.commentId} by ${action.author}`);
                        done.push('deleted');
                        break;

                    case 'block':
                        await forge.blockUser(action.author);
                        blocked = true;
                        await this.trust.recordBlock(forge, action.author);
                        await this.audit(repo, 'block_user', action, `Blocked ${action.author}`);
                        this.logger.info(`Blocked user ${action.author}`);
                        done.push('blocked');
                        break;

                    case 'report':
                        if (!blocked) { break; }
                        // Platform reports never include the hostile text.
                        await forge.reportUser(action.author, `Automated moderation: ${action.reason}`);
                        await this.audit(repo, 'report_user', action, `Reported ${action.author}`);
                        done.push('reported');
                        break;

                    default:
                        break;
                }
            } catch (err) {
                if (err instanceof HaltedError) { throw err; }
                action.needsHumanReview = true;
                if (err instanceof UnsupportedError) {
                    this.logger.warn(`${act} not supported on ${forge.platform} — ${action.author} needs manual review`);
                } else if (err instanceof ForgeRateLimitError) {
                    this.logger.warn(`${act} skipped: ${err.message}`);
                } else {
                    this.logger.error(`Failed to ${act} for comment ${action.commentId}: ${err instanceof Error ? err.name : 'error'}`);
                }
            }
        }

        action.actionsTaken = done;
    }

    private async audit(
        repo: string,
        kind: 'flag_comment' | 'delete_comment' | 'block_user' | 'report_user',
        action: CommentAction,
        decision: string,
    ): Promise<void> {
        await this.auditLog.append({
            action: kind,
            repo,
            target: action.commentId,
            input: action.commentId,
            output: [...action.actions, ...action.actionsTaken].join(','),
            decision,
            llmCallCount: 0,
            details: action.reason,
        });
    }
}
