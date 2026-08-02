// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Comment handler — evaluates all comments on issues/PRs.
 *
 * - Determines relevance & merit
 * - Detects adversarial content (threats, injection, social engineering)
 * - Applies graduated trust model
 * - Can flag, delete comments, block/report hostile users
 * - Owner is immune for testing purposes
 */

import type { Forge, Comment } from '../forge/types';
import type { CommentEvaluation, TrackedIssue } from './types';
import type { Logger } from '../util/logger';
import type { Sanitizer } from '../security/sanitizer';
import type { ThreatClassifier } from '../security/threat-classifier';
import type { TrustResolver } from '../security/trust';
import type { AuditLog } from '../crypto/audit';
import { computeThresholds } from '../security/types';

export interface CommentAction {
    commentId: string;
    author: string;
    evaluation?: CommentEvaluation;
    threatClassification: 'clean' | 'suspicious' | 'hostile';
    actions: ('flag' | 'delete' | 'block' | 'report' | 'update_pr' | 'none')[];
    reason: string;
}

export class CommentHandler {
    constructor(
        private readonly logger: Logger,
        private readonly sanitizer: Sanitizer,
        private readonly threatClassifier: ThreatClassifier,
        private readonly trustResolver: TrustResolver,
        private readonly auditLog: AuditLog,
    ) {}

    /**
     * Process all new comments on an issue or PR.
     * Returns actions taken for each comment.
     */
    async processComments(
        forge: Forge,
        issue: TrackedIssue,
        comments: Comment[],
    ): Promise<CommentAction[]> {
        const results: CommentAction[] = [];

        for (const comment of comments) {
            try {
                const action = await this.processOneComment(forge, issue, comment);
                results.push(action);

                // Execute actions
                await this.executeActions(forge, action);
            } catch (err) {
                this.logger.error(`Failed processing comment ${comment.id}: ${err}`);
                results.push({
                    commentId: comment.id,
                    author: comment.author,
                    threatClassification: 'clean',
                    actions: ['none'],
                    reason: `Processing error: ${err}`,
                });
            }
        }

        return results;
    }

    private async processOneComment(
        forge: Forge,
        issue: TrackedIssue,
        comment: Comment,
    ): Promise<CommentAction> {
        // 1. Sanitize the comment body
        const sanitized = this.sanitizer.sanitize(comment.body);

        // 2. Resolve user trust
        const trust = await this.trustResolver.resolve(forge, comment.author);

        // 3. Classify threat level
        const threat = await this.threatClassifier.classify(
            sanitized,
            comment.author,
            `comment on issue #${issue.issueNumber}`,
        );

        // 4. Compute thresholds based on trust
        const thresholds = computeThresholds(trust.effectiveTrustScore);

        // 5. Decide actions
        const actions: CommentAction['actions'] = [];

        if (trust.tier === 'owner') {
            // Owner is immune — always clean for moderation purposes
            // But still evaluate for content merit
            this.logger.debug(`Owner @${comment.author} is immune from moderation`);
            actions.push('none');

            return {
                commentId: comment.id,
                author: comment.author,
                threatClassification: 'clean',
                actions,
                reason: 'Owner is immune from moderation',
            };
        }

        if (threat.classification === 'hostile' && threat.confidence >= thresholds.blockThreshold) {
            actions.push('delete', 'block');

            if (threat.confidence >= thresholds.reportThreshold) {
                actions.push('report');
            }

            await this.auditLog.append({
                action: 'flag_comment',
                repo: `${forge.owner}/${forge.repo}`,
                target: comment.url,
                input: '',
                output: '',
                decision: `Hostile comment by @${comment.author} — ${actions.join(', ')}`,
                llmCallCount: 1,
                details: `Trust: ${trust.effectiveTrustScore.toFixed(2)}, Threat: ${threat.confidence.toFixed(2)} (${threat.threatType || 'unknown'})`,
            });

            return {
                commentId: comment.id,
                author: comment.author,
                threatClassification: 'hostile',
                actions,
                reason: `Hostile content (${threat.threatType}): confidence ${(threat.confidence * 100).toFixed(0)}%, trust ${(trust.effectiveTrustScore * 100).toFixed(0)}%`,
            };
        }

        if (threat.classification === 'suspicious' || threat.confidence >= thresholds.flagThreshold) {
            actions.push('flag');

            await this.auditLog.append({
                action: 'flag_comment',
                repo: `${forge.owner}/${forge.repo}`,
                target: comment.url,
                input: '',
                output: '',
                decision: `Suspicious comment by @${comment.author} — flagged`,
                llmCallCount: 1,
                details: `Trust: ${trust.effectiveTrustScore.toFixed(2)}, Threat: ${threat.confidence.toFixed(2)}`,
            });

            return {
                commentId: comment.id,
                author: comment.author,
                threatClassification: 'suspicious',
                actions,
                reason: `Suspicious content: confidence ${(threat.confidence * 100).toFixed(0)}%`,
            };
        }

        // Clean comment — no moderation needed
        actions.push('none');
        return {
            commentId: comment.id,
            author: comment.author,
            threatClassification: 'clean',
            actions,
            reason: 'Clean',
        };
    }

    private async executeActions(forge: Forge, action: CommentAction): Promise<void> {
        for (const act of action.actions) {
            try {
                switch (act) {
                    case 'delete':
                        await forge.deleteComment(action.commentId);
                        this.logger.info(`Deleted comment ${action.commentId} by @${action.author}`);
                        await this.auditLog.append({
                            action: 'delete_comment',
                            repo: `${forge.owner}/${forge.repo}`,
                            target: action.commentId,
                            input: '', output: '',
                            decision: action.reason,
                            llmCallCount: 0,
                            details: `Comment by @${action.author}`,
                        });
                        break;

                    case 'block':
                        await forge.blockUser(action.author);
                        this.logger.info(`Blocked user @${action.author}`);
                        await this.auditLog.append({
                            action: 'block_user',
                            repo: `${forge.owner}/${forge.repo}`,
                            target: action.author,
                            input: '', output: '',
                            decision: action.reason,
                            llmCallCount: 0,
                            details: `Triggered by comment ${action.commentId}`,
                        });
                        break;

                    case 'report':
                        await forge.reportUser(action.author, action.reason);
                        this.logger.info(`Reported user @${action.author}`);
                        await this.auditLog.append({
                            action: 'report_user',
                            repo: `${forge.owner}/${forge.repo}`,
                            target: action.author,
                            input: '', output: '',
                            decision: action.reason,
                            llmCallCount: 0,
                            details: `Triggered by comment ${action.commentId}`,
                        });
                        break;

                    case 'flag':
                        // Just log — no forge action needed for flags
                        this.logger.info(`Flagged comment ${action.commentId} by @${action.author}: ${action.reason}`);
                        break;

                    case 'none':
                        break;
                }
            } catch (err) {
                this.logger.error(`Failed to execute ${act} for comment ${action.commentId}: ${err}`);
            }
        }
    }
}
