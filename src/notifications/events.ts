// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Event routing — connects pipeline events to the email notification system.
 */

import type { EmailSender } from './email';
import type { Logger } from '../util/logger';
import type { RepoKey } from '../forge/types';
import type { TrackedIssue, IssueEvaluation, PRAnalysis, CodingIteration } from '../agent/types';
import * as templates from './templates';

export type EventType =
    | 'issue_evaluated'
    | 'pr_created'
    | 'threat_detected'
    | 'competing_prs_analyzed'
    | 'pipeline_error';

export class NotificationRouter {
    constructor(
        private readonly emailSender: EmailSender,
        private readonly logger: Logger,
    ) {}

    async onIssueEvaluated(issue: TrackedIssue, evaluation: IssueEvaluation, repoKey?: RepoKey): Promise<void> {
        try {
            const msg = templates.issueEvaluated(issue, evaluation);
            await this.emailSender.send(msg, repoKey);
        } catch (err) {
            this.logger.warn(`Failed to send issue evaluation email: ${err}`);
        }
    }

    async onPRCreated(issue: TrackedIssue, iterations: CodingIteration[], repoKey?: RepoKey): Promise<void> {
        try {
            const msg = templates.prCreated(issue, iterations);
            await this.emailSender.send(msg, repoKey);
        } catch (err) {
            this.logger.warn(`Failed to send PR created email: ${err}`);
        }
    }

    async onThreatDetected(
        repo: string,
        username: string,
        classification: string,
        confidence: number,
        actions: string[],
        repoKey?: RepoKey,
    ): Promise<void> {
        try {
            const msg = templates.threatDetected(repo, username, classification, confidence, actions);
            await this.emailSender.send(msg, repoKey);
        } catch (err) {
            this.logger.warn(`Failed to send threat detection email: ${err}`);
        }
    }

    async onCompetingPRsAnalyzed(issue: TrackedIssue, analyses: PRAnalysis[], repoKey?: RepoKey): Promise<void> {
        try {
            const msg = templates.competingPRsAnalyzed(issue, analyses);
            await this.emailSender.send(msg, repoKey);
        } catch (err) {
            this.logger.warn(`Failed to send competing PR email: ${err}`);
        }
    }

    async onPipelineError(issueNumber: number, repo: string, error: string, repoKey?: RepoKey): Promise<void> {
        try {
            const msg = templates.pipelineError(issueNumber, repo, error);
            await this.emailSender.send(msg, repoKey);
        } catch (err) {
            this.logger.warn(`Failed to send pipeline error email: ${err}`);
        }
    }
}
