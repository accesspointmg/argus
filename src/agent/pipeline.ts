// Copyright 2026 Colin Byron. Apache-2.0 license.

/**
 * Pipeline — the main orchestrator that drives Argus's issue processing.
 *
 * Flow:
 *  1. Poll for new issues
 *  2. Evaluate each issue (LLM merit assessment)
 *  3. Investigate (code search, file reads)
 *  4. Create branch
 *  5. Code (iterative LLM generation + CI check loop)
 *  6. Create PR with full transcription
 *  7. Monitor comments
 *  8. Analyze competing PRs
 *  9. Optionally synthesize a "super PR"
 */

import { createHash } from 'crypto';
import type { Forge, Issue, PullRequest, RepoKey, ReviewComment } from '../forge/types';
import {
    TrackedIssue,
    IssueState,
    IssueSession,
    ActivityEntry,
} from './types';
import { Evaluator } from './evaluator';
import { Investigator } from './investigator';
import { Coder } from './coder';
import { Transcriber } from './transcriber';
import { CommentHandler } from './comment-handler';
import { EditDetector } from './edit-detector';
import { PRAnalyzer } from './pr-analyzer';
import { LoopDetector, ChainAnalysis } from './loop-detector';
import { EngagementPolicy, EngagementDecision } from './engagement';
import type { StampManager } from '../crypto/stamp';
import type { AuditLog } from '../crypto/audit';
import type { Logger } from '../util/logger';

export interface PipelineConfig {
    maxConcurrentIssues: number;
    maxCodingIterations: number;
    commentCheckInterval: number;  // ms
    prPrefix: string;              // e.g., "argus/"
    branchPrefix: string;
    dryRun: boolean;
    /**
     * Comments Argus may post on one issue thread before going quiet.
     * Mirrors MAX_ACKS_PER_PR, which bounds the PR side.
     */
    maxCommentsPerThread: number;
}

const DEFAULT_CONFIG: PipelineConfig = {
    maxConcurrentIssues: 3,
    maxCodingIterations: 5,
    commentCheckInterval: 60_000,
    prPrefix: '',
    branchPrefix: 'argus/',
    dryRun: false,
    maxCommentsPerThread: 3,
};

// ─── Bot Detection ──────────────────────────────────────────────

/**
 * Patterns that match bot *conversation* comments that are pure noise.
 * These are messages like "I've opened a new pull request #13" posted by
 * copilot-swe-agent — they don't contain substantive feedback and should
 * not trigger Argus to post another acknowledgment.
 *
 * Inline code-review comments from bots (e.g., copilot-pull-request-reviewer)
 * are NOT filtered — those contain valuable technical feedback that Argus
 * should evaluate.
 */
const BOT_NOISE_PATTERNS: RegExp[] = [
    /I've opened a new pull request/i,
    /I'll request review from you/i,
    /I was blocked by some firewall rules/i,
    /Once the pull request is ready/i,
];

/**
 * Returns true if a conversation comment is bot-generated noise
 * that should NOT trigger another Argus acknowledgment.
 *
 * This is intentionally narrow: only messages matching known noise patterns
 * from [bot] accounts are filtered. Any substantive comment — even from a
 * bot — passes through so Argus can evaluate it.
 */
function isBotNoise(author: string, body: string): boolean {
    // Only apply noise filter to bot accounts
    if (!author.toLowerCase().endsWith('[bot]')) {
        return false;
    }
    // Check if the message matches any known noise pattern
    return BOT_NOISE_PATTERNS.some((pattern) => pattern.test(body));
}

// ─── Rate Limiting ──────────────────────────────────────────────

interface AckRecord {
    count: number;
    firstAckAt: Date;
    lastAckAt: Date;
}

/**
 * Max acknowledgments per PR before Argus backs off.
 * This allows 2–3 rounds of productive back-and-forth with Copilot
 * or human reviewers, then stops to prevent runaway loops.
 */
const MAX_ACKS_PER_PR = 3;

/** Window in which MAX_ACKS_PER_PR applies (ms). Reset after this. */
const ACK_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

export class Pipeline {
    private workQueue: TrackedIssue[] = [];
    private activity: ActivityEntry[] = [];
    private sessions = new Map<string, IssueSession>();
    private config: PipelineConfig;

    // Track last poll time per repo
    private lastPollTimes = new Map<RepoKey, Date>();

    /** Tracks how many times we've acknowledged each PR to prevent loops. */
    private ackTracker = new Map<string, AckRecord>();

    /** PRs where Argus has already posted a loop-detected comment. */
    private loopDisengaged = new Set<string>();

    /** Chain-tracing loop detector shared across poll cycles. */
    private loopDetector: LoopDetector;

    /** Decides whether a thread still warrants a comment from us. */
    private engagementPolicy: EngagementPolicy;

    constructor(
        private readonly evaluator: Evaluator,
        private readonly investigator: Investigator,
        private readonly coder: Coder,
        private readonly transcriber: Transcriber,
        private readonly commentHandler: CommentHandler,
        private readonly editDetector: EditDetector,
        private readonly prAnalyzer: PRAnalyzer,
        private readonly stampManager: StampManager,
        private readonly auditLog: AuditLog,
        private readonly logger: Logger,
        config?: Partial<PipelineConfig>,
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.loopDetector = new LoopDetector(stampManager, logger);
        this.engagementPolicy = new EngagementPolicy(stampManager, logger, {
            maxComments: this.config.maxCommentsPerThread,
        });
    }

    // ─── Public API ─────────────────────────────────────────────────

    /** Poll a repo for new issues and enqueue them. */
    async pollRepo(forge: Forge): Promise<number> {
        const repoKey: RepoKey = `${forge.platform}:${forge.owner}/${forge.repo}`;
        const since = this.lastPollTimes.get(repoKey) || new Date(Date.now() - 24 * 60 * 60 * 1000);

        this.logger.info(`Polling ${repoKey} for issues since ${since.toISOString()}`);

        const issues = await forge.listNewIssues(since);
        this.lastPollTimes.set(repoKey, new Date());

        let enqueued = 0;
        for (const issue of issues) {
            if (this.isAlreadyTracked(issue)) {
                continue;
            }

            // Decide whether there is anything new worth saying, and whether we
            // have already said enough on this thread.
            const engagement = await this.shouldEngage(forge, issue.number);
            if (!engagement.engage) {
                this.logger.info(`Skipping issue #${issue.number} — ${engagement.reason}`);
                continue;
            }

            const tracked: TrackedIssue = {
                issueNumber: issue.number,
                repo: repoKey,
                title: issue.title,
                url: issue.url,
                state: 'pending',
                createdAt: issue.createdAt,
                bodyHash: createHash('sha256').update(issue.body || '').digest('hex'),
                currentIteration: 0,
                maxIterations: this.config.maxCodingIterations,
            };

            this.workQueue.push(tracked);
            this.addActivity(repoKey, issue.number, undefined, '📥', `Enqueued issue #${issue.number}: ${issue.title}`, issue.url);
            enqueued++;
        }

        await this.auditLog.append({
            action: 'poll_repos',
            repo: `${forge.owner}/${forge.repo}`,
            target: repoKey,
            input: since.toISOString(),
            output: String(issues.length),
            decision: `Found ${issues.length} issues, enqueued ${enqueued}`,
            llmCallCount: 0,
            details: `Poll ${repoKey}`,
        });

        return enqueued;
    }

    /** Process the next issue in the work queue. */
    async processNext(forge: Forge): Promise<TrackedIssue | undefined> {
        const next = this.workQueue.find((i) => i.state === 'pending');
        if (!next) {
            return undefined;
        }

        // Check concurrent limit
        const active = this.workQueue.filter((i) =>
            !['pending', 'done', 'skipped', 'flagged', 'stuck', 'rejected'].includes(i.state)
        );
        if (active.length >= this.config.maxConcurrentIssues) {
            this.logger.debug(`Concurrent limit reached (${active.length}/${this.config.maxConcurrentIssues})`);
            return undefined;
        }

        return await this.processIssue(forge, next);
    }

    /** Process a specific issue through the full pipeline. */
    async processIssue(forge: Forge, issue: TrackedIssue): Promise<TrackedIssue> {
        const sessionKey = `${issue.repo}:${issue.issueNumber}`;
        const session: IssueSession = {
            issueNumber: issue.issueNumber,
            repo: issue.repo,
            startedAt: new Date(),
            llmConversationHistory: [],
            filesRead: [],
            filesModified: [],
            stampsGenerated: [],
            noncesUsed: [],
            llmCallCount: 0,
            aborted: false,
        };
        this.sessions.set(sessionKey, session);
        issue.startedAt = new Date();

        try {
            // ── Step 1: Evaluate ──
            issue.state = 'evaluating';
            this.addActivity(issue.repo, issue.issueNumber, undefined, '🔍', `Evaluating issue #${issue.issueNumber}`);
            this.logger.info(`Evaluating issue #${issue.issueNumber}: ${issue.title}`);

            const evaluation = await this.evaluator.evaluate(forge, await forge.getIssue(issue.issueNumber));
            issue.evaluation = evaluation;

            await this.auditLog.append({
                action: 'evaluate_issue',
                repo: `${forge.owner}/${forge.repo}`,
                target: issue.url,
                input: issue.bodyHash,
                output: JSON.stringify(evaluation),
                decision: evaluation.merit ? 'approved' : 'rejected',
                llmCallCount: 1,
                details: evaluation.reasoning.substring(0, 200),
            });

            if (!evaluation.merit) {
                // Safety net: low-confidence rejections get flipped to approved
                if (evaluation.confidence < 0.7) {
                    this.logger.warn(
                        `Overriding low-confidence rejection for #${issue.issueNumber} ` +
                        `(confidence: ${evaluation.confidence.toFixed(2)}) — accepting for investigation`,
                    );
                    evaluation.merit = true;
                    evaluation.reasoning = `[Auto-accepted: low confidence rejection overridden] ${evaluation.reasoning}`;
                    evaluation.suggestedLabels = [...(evaluation.suggestedLabels || []), 'argus:low-confidence-override'];
                } else {
                    issue.state = 'rejected';
                    this.addActivity(issue.repo, issue.issueNumber, undefined, '❌', `Rejected issue #${issue.issueNumber}: ${evaluation.reasoning.substring(0, 100)}`);
                    return issue;
                }
            }

            issue.state = 'approved';
            this.addActivity(issue.repo, issue.issueNumber, undefined, '✅', `Approved issue #${issue.issueNumber} (${evaluation.category}/${evaluation.severity})`);

            // ── Step 2: Create branch ──
            issue.state = 'branching';
            const defaultBranch = await forge.getDefaultBranch();
            const branchName = `${this.config.branchPrefix}issue-${issue.issueNumber}`;
            issue.branchName = branchName;

            if (!this.config.dryRun) {
                await forge.createBranch(defaultBranch, branchName);
            }
            this.addActivity(issue.repo, issue.issueNumber, undefined, '🌿', `Created branch ${branchName}`);

            // ── Step 3: Investigate ──
            this.logger.info(`Investigating codebase for issue #${issue.issueNumber}`);
            const investigation = await this.investigator.investigate(forge, evaluation, defaultBranch);

            // ── Step 4: Code ──
            issue.state = 'coding';
            this.addActivity(issue.repo, issue.issueNumber, undefined, '🔧', `Coding solution for issue #${issue.issueNumber}`);

            // Check for edits before coding
            const editCheck = await this.editDetector.check(forge, issue);
            if (editCheck.detected && editCheck.action === 'halt') {
                issue.state = 'flagged';
                issue.error = editCheck.reason;
                this.addActivity(issue.repo, issue.issueNumber, undefined, '🚨', `HALTED: ${editCheck.reason}`);
                return issue;
            }

            const iterations = this.config.dryRun ? [] : await this.coder.code(forge, issue, evaluation, investigation);

            // ── Step 5: Create PR ──
            const lastIteration = iterations[iterations.length - 1];
            const ciPassed = lastIteration?.ciResult === 'passing';

            if (!this.config.dryRun && iterations.length > 0) {
                issue.state = 'pr-open';
                const prTitle = `${evaluation.category}: ${issue.title} (fixes #${issue.issueNumber})`;
                const prBody = await this.buildPRBody(issue, evaluation, iterations);

                const pr = await forge.createPullRequest(
                    branchName,
                    defaultBranch,
                    prTitle,
                    prBody,
                );

                issue.prNumber = pr.number;
                issue.prUrl = pr.url;

                // Post transcription comments
                await this.transcriber.postEvaluation(forge, pr.number, issue, evaluation);
                await this.transcriber.postInvestigation(forge, pr.number, investigation);
                for (const it of iterations) {
                    await this.transcriber.postIteration(forge, pr.number, it);
                }
                await this.transcriber.postSummary(forge, pr.number, issue, iterations);

                await this.auditLog.append({
                    action: 'create_pr',
                    repo: `${forge.owner}/${forge.repo}`,
                    target: pr.url,
                    input: issue.bodyHash,
                    output: prBody,
                    decision: `PR #${pr.number} created`,
                    llmCallCount: iterations.length,
                    details: `${iterations.length} iterations, CI ${ciPassed ? 'passing' : 'not passing'}`,
                });

                this.addActivity(issue.repo, issue.issueNumber, pr.number, '📤', `Opened PR #${pr.number}`, pr.url);

                // ── Step 5b: Post acknowledgment on the issue ──
                await this.postIssueAcknowledgment(forge, issue, pr.number, pr.url, evaluation);

                // ── Step 6: Monitor comments on the issue ──
                await this.processNewIssueComments(forge, issue);

                // ── Step 6b: Monitor PR review comments (e.g., from Copilot, reviewers) ──
                await this.processNewPRComments(forge, issue);

                // ── Step 7: Analyze competing PRs ──
                issue.state = 'analyzing-competing';
                const competing = await this.prAnalyzer.analyzeCompetingPRs(forge, issue);
                issue.competingPRs = competing;

                if (competing.length > 0) {
                    await this.transcriber.postCompetitiveAnalysis(forge, pr.number, competing);
                    this.addActivity(issue.repo, issue.issueNumber, pr.number, '⚔️', `Analyzed ${competing.length} competing PRs`);

                    // ── Step 7: Synthesize if warranted ──
                    const ourAnalysis = competing.find((a) => a.isOurInstance);
                    if (this.prAnalyzer.shouldSynthesize(ourAnalysis, competing.filter((c) => !c.isOurInstance))) {
                        issue.state = 'synthesizing';
                        const synthesisPlan = await this.prAnalyzer.planSynthesis(
                            competing.filter((c) => !c.isOurInstance),
                            ourAnalysis,
                        );
                        await this.transcriber.postSynthesisPlan(forge, pr.number, synthesisPlan);
                        this.addActivity(issue.repo, issue.issueNumber, pr.number, '🧬', 'Planned super PR synthesis');
                    }
                }
            }

            issue.state = 'done';
            issue.completedAt = new Date();
            this.addActivity(issue.repo, issue.issueNumber, issue.prNumber, '✔️', `Completed issue #${issue.issueNumber}`);

        } catch (err) {
            issue.state = 'stuck';
            issue.error = String(err);
            this.logger.error(`Pipeline failed for issue #${issue.issueNumber}: ${err}`);
            this.addActivity(issue.repo, issue.issueNumber, undefined, '💥', `Error: ${String(err).substring(0, 100)}`);
        } finally {
            this.sessions.delete(sessionKey);
        }

        return issue;
    }

    // ─── State Access ───────────────────────────────────────────────

    getWorkQueue(): readonly TrackedIssue[] {
        return this.workQueue;
    }

    getActivity(limit: number = 50): readonly ActivityEntry[] {
        return this.activity.slice(-limit);
    }

    getIssuesByState(state: IssueState): TrackedIssue[] {
        return this.workQueue.filter((i) => i.state === state);
    }

    // ─── Private Helpers ────────────────────────────────────────────

    private isAlreadyTracked(issue: Issue): boolean {
        return this.workQueue.some(
            (t) => t.issueNumber === issue.number && t.repo === issue.repo
        );
    }

    /**
     * Detect work-in-progress PRs that should not be engaged yet.
     *
     * Checks:
     *  1. GitHub/GitLab "draft" flag (mapped from the API).
     *  2. Title prefixes: `[WIP]`, `WIP:`, `Draft:`, `[Draft]`.
     *  3. Construction emoji 🚧 in title.
     */
    private isWorkInProgress(pr: PullRequest): boolean {
        if (pr.draft) { return true; }

        const title = pr.title.trim();
        const upper = title.toUpperCase();
        if (
            upper.startsWith('[WIP]') ||
            upper.startsWith('WIP:') ||
            upper.startsWith('WIP ') ||
            upper.startsWith('DRAFT:') ||
            upper.startsWith('[DRAFT]') ||
            title.includes('🚧')
        ) {
            return true;
        }

        return false;
    }

    private addActivity(
        repo: RepoKey,
        issueNumber: number | undefined,
        prNumber: number | undefined,
        icon: string,
        message: string,
        url?: string,
    ): void {
        this.activity.push({
            timestamp: new Date(),
            repo,
            issueNumber,
            prNumber,
            icon,
            message,
            url,
        });

        // Keep activity log bounded
        if (this.activity.length > 500) {
            this.activity = this.activity.slice(-300);
        }
    }

    private async buildPRBody(
        issue: TrackedIssue,
        evaluation: any,
        iterations: any[],
    ): Promise<string> {
        const lastIteration = iterations[iterations.length - 1];

        const content = `## Automated Fix for #${issue.issueNumber}

${evaluation.reasoning}

### Approach
${evaluation.proposedApproach}

### Changes
${iterations.flatMap((it: any) => it.filesChanged.map((f: any) => `- \`${f.path}\``)).join('\n') || '_See iteration comments_'}

### CI Status
${lastIteration?.ciResult === 'passing' ? '✅ Passing' : '⚠️ Not passing — human review recommended'}

---

> 🤖 This PR was generated by **Argus** — an AI code issue agent.
> It should be reviewed by a human before merging.
> **Argus never merges PRs.**
>
> See the comments below for full AI reasoning transcription.`;

        const { stamped } = this.stampManager.stampContent(content);
        return stamped;
    }

    // ─── Issue Comment Management ───────────────────────────────────

    /**
     * Decide whether to engage with a thread.
     *
     * Delegates to {@link EngagementPolicy}, which bounds how much Argus says
     * per thread and refuses to trade comments with other agents. This replaced
     * an earlier "does Argus have the last word?" check: that re-engaged
     * whenever anybody else commented last, so two agents applying the same
     * rule alternated indefinitely.
     *
     * Fails open — if comments cannot be read we treat the thread as fresh,
     * since going silent on a transient API error looks like Argus is dead.
     */
    private async shouldEngage(forge: Forge, issueNumber: number): Promise<EngagementDecision> {
        try {
            const comments = await forge.getIssueComments(issueNumber);
            return this.engagementPolicy.decide(comments);
        } catch (err) {
            this.logger.debug(`Could not read comments for issue #${issueNumber}: ${err}`);
            return {
                engage: true,
                reason: 'Could not read comments — treating as a fresh thread',
                ourComments: 0,
                budget: 0,
            };
        }
    }

    /**
     * Post a stamped acknowledgment comment on the original issue linking to the PR.
     * This serves two purposes:
     *  1. Tells the issue author that Argus is working on it
     *  2. Marks the issue as processed (stamp prevents re-evaluation)
     */
    private async postIssueAcknowledgment(
        forge: Forge,
        issue: TrackedIssue,
        prNumber: number,
        prUrl: string,
        evaluation: any,
    ): Promise<void> {
        const content = `## 🤖 Argus — Issue Acknowledged

I've evaluated this issue and created a pull request with a proposed fix.

| | |
|---|---|
| **Pull Request** | #${prNumber} |
| **Category** | ${evaluation.category} |
| **Severity** | ${evaluation.severity} |
| **Confidence** | ${(evaluation.confidence * 100).toFixed(0)}% |

### Proposed Approach
${evaluation.proposedApproach}

> Please review the PR for the full AI reasoning transcript and code changes.
> Argus **never** merges PRs — a human must approve and merge.`;

        const { stamped } = this.stampManager.stampContent(content);
        await forge.addComment(issue.issueNumber, stamped);
        this.logger.info(`Posted acknowledgment on issue #${issue.issueNumber} linking to PR #${prNumber}`);
        this.addActivity(issue.repo, issue.issueNumber, prNumber, '💬', `Posted acknowledgment on issue #${issue.issueNumber}`);
    }

    /**
     * Check for new comments on an issue that Argus hasn't responded to.
     * Runs the comment handler for moderation, plus evaluates content comments
     * for relevance (e.g., additional context, corrections, requests).
     */
    private async processNewIssueComments(
        forge: Forge,
        issue: TrackedIssue,
    ): Promise<void> {
        try {
            const comments = await forge.getIssueComments(issue.issueNumber);

            // Find comments that are NOT from Argus (no stamp) and came after
            // the issue was first enqueued
            const ourCommentDates = new Set<string>();
            const newComments: typeof comments = [];

            for (const comment of comments) {
                if (this.stampManager.hasStamp(comment.body)) {
                    ourCommentDates.add(comment.id);
                    continue;
                }
                // Only look at comments posted after we started processing
                if (issue.startedAt && comment.createdAt > issue.startedAt) {
                    newComments.push(comment);
                }
            }

            if (newComments.length === 0) {
                this.logger.debug(`No new comments on issue #${issue.issueNumber}`);
                return;
            }

            this.logger.info(
                `Processing ${newComments.length} new comment(s) on issue #${issue.issueNumber}`,
            );

            // Run moderation/threat assessment on new comments
            const actions = await this.commentHandler.processComments(
                forge, issue, newComments,
            );

            // Log results
            for (const action of actions) {
                if (action.threatClassification !== 'clean') {
                    this.addActivity(
                        issue.repo, issue.issueNumber, issue.prNumber,
                        '🛡️', `Comment by @${action.author}: ${action.threatClassification}`,
                    );
                }
            }

            // For clean comments that might contain useful feedback,
            // post a stamped acknowledgment
            const cleanComments = newComments.filter((c) => {
                const action = actions.find((a) => a.commentId === c.id);
                return action && action.threatClassification === 'clean';
            });

            if (cleanComments.length > 0 && issue.prNumber) {
                const commentSummary = cleanComments
                    .map((c) => `- @${c.author}: ${c.body.substring(0, 200)}`)
                    .join('\n');

                const content = `## 💬 New Comments Noted

${cleanComments.length} new comment(s) received on issue #${issue.issueNumber} after PR creation:

${commentSummary}

> These comments have been logged. If they require code changes, please comment on this PR with specific instructions.`;

                const { stamped } = this.stampManager.stampContent(content);
                await forge.addPRComment(issue.prNumber, stamped);
                this.addActivity(
                    issue.repo, issue.issueNumber, issue.prNumber,
                    '💬', `Noted ${cleanComments.length} new comment(s) on issue`,
                );
            }
        } catch (err) {
            this.logger.error(`Failed processing comments for issue #${issue.issueNumber}: ${err}`);
        }
    }

    /**
     * Check for review comments on the PR (inline code review feedback).
     * This catches feedback from GitHub Copilot, human reviewers, and other
     * automated tools that post review comments on the PR's diff.
     *
     * Anti-loop design:
     *  - Only includes comments NEWER than `sinceDate` (last Argus stamp)
     *  - Bot conversation comments are already filtered by the caller
     *  - The acknowledgment includes an HTML directive `<!-- argus:ack -->`
     *    that signals to other bots not to treat this as an action request
     *  - Wording is purely informational — no language suggesting action
     */
    private async processNewPRComments(
        forge: Forge,
        issue: TrackedIssue,
        sinceDate?: Date | null,
    ): Promise<void> {
        if (!issue.prNumber) { return; }

        try {
            // Fetch both regular PR conversation comments and inline review comments
            const [conversationComments, reviewComments] = await Promise.all([
                forge.getPRComments(issue.prNumber),
                forge.getPRReviewComments(issue.prNumber),
            ]);

            // Filter out Argus's own comments (stamped) and bot conversation noise
            let externalConversation = conversationComments.filter(
                (c) => !this.stampManager.hasStamp(c.body) && !isBotNoise(c.author, c.body),
            );
            let externalReviews = reviewComments.filter(
                (rc) => !this.stampManager.hasStamp(rc.body),
            );

            // Only include comments NEWER than our last acknowledgment
            if (sinceDate) {
                externalConversation = externalConversation.filter((c) => c.createdAt > sinceDate);
                externalReviews = externalReviews.filter((rc) => rc.createdAt > sinceDate);
            }

            if (externalConversation.length === 0 && externalReviews.length === 0) {
                this.logger.debug(`No new external comments on PR #${issue.prNumber}`);
                return;
            }

            this.logger.info(
                `Found ${externalConversation.length} conversation + ${externalReviews.length} review comment(s) on PR #${issue.prNumber} (new since ${sinceDate?.toISOString() ?? 'start'})`,
            );

            // Run moderation on conversation comments (they fit the Comment interface)
            if (externalConversation.length > 0) {
                const actions = await this.commentHandler.processComments(
                    forge, issue, externalConversation,
                );
                for (const action of actions) {
                    if (action.threatClassification !== 'clean') {
                        this.addActivity(
                            issue.repo, issue.issueNumber, issue.prNumber,
                            '🛡️', `PR comment by @${action.author}: ${action.threatClassification}`,
                        );
                    }
                }
            }

            // Build a summary of review comments grouped by file
            const reviewsByFile = this.groupReviewsByFile(externalReviews);

            // Build response
            const sections: string[] = [];

            if (externalConversation.length > 0) {
                const convSnippets = externalConversation
                    .map((c) => `- **@${c.author}**: ${c.body.substring(0, 300)}${c.body.length > 300 ? '…' : ''}`)
                    .join('\n');
                sections.push(`### Conversation Comments\n\n${convSnippets}`);
            }

            if (externalReviews.length > 0) {
                const fileGroups: string[] = [];
                for (const [filePath, comments] of reviewsByFile.entries()) {
                    const items = comments
                        .map((rc) => {
                            const lineRef = rc.line ? `L${rc.line}` : 'file-level';
                            return `  - **@${rc.author}** (${lineRef}): ${rc.body.substring(0, 250)}${rc.body.length > 250 ? '…' : ''}`;
                        })
                        .join('\n');
                    fileGroups.push(`- \`${filePath}\`\n${items}`);
                }
                sections.push(`### Code Review Comments\n\n${fileGroups.join('\n')}`);
            }

            // Anti-loop: HTML directive tells bots this is informational only.
            const content = `<!-- argus:ack — this is an automated log entry, not an action request -->
## 📋 Feedback Noted

${externalConversation.length + externalReviews.length} new comment(s) since last check.

${sections.join('\n\n')}

> Argus has recorded this feedback for the maintainer to review.
> No automated action will be taken — a human decides whether changes are needed.`;

            const { stamped } = this.stampManager.stampContent(content);
            await forge.addPRComment(issue.prNumber, stamped);
            this.addActivity(
                issue.repo, issue.issueNumber, issue.prNumber,
                '👀', `Logged ${externalReviews.length} review + ${externalConversation.length} conversation comment(s) on PR`,
            );

        } catch (err) {
            this.logger.error(`Failed processing PR comments for PR #${issue.prNumber}: ${err}`);
        }
    }

    /**
     * Group review comments by file path for structured display.
     */
    private groupReviewsByFile(reviews: ReviewComment[]): Map<string, ReviewComment[]> {
        const grouped = new Map<string, ReviewComment[]>();
        for (const rc of reviews) {
            const key = rc.path || '(unknown file)';
            if (!grouped.has(key)) { grouped.set(key, []); }
            grouped.get(key)!.push(rc);
        }
        // Sort comments within each file by line number
        for (const [, comments] of grouped) {
            comments.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
        }
        return grouped;
    }

    /**
     * Poll all open PRs in the repo for unacknowledged comments.
     * This runs independently of the issue pipeline — it catches review
     * comments from GitHub Copilot, human reviewers, and other automated
     * tools on ANY open PR, not just ones tied to a specific issue.
     *
     * Before checking each PR, the LoopDetector traces the full chain
     * of related PRs.  If a chain has grown beyond the allowed depth
     * or the same feedback is cycling, Argus posts a final "loop detected"
     * comment and disengages.
     *
     * Returns the number of PRs that received new acknowledgments.
     */
    async pollPRComments(forge: Forge): Promise<number> {
        const repoKey: RepoKey = `${forge.platform}:${forge.owner}/${forge.repo}`;
        let acknowledged = 0;

        try {
            const openPRs = await forge.listOpenPRs();
            this.logger.debug(`Checking ${openPRs.length} open PR(s) in ${repoKey} for new comments`);

            for (const pr of openPRs) {
                try {
                    // ── Skip work-in-progress PRs ──
                    if (this.isWorkInProgress(pr)) {
                        this.logger.debug(
                            `PR #${pr.number}: work in progress — skipping`,
                        );
                        continue;
                    }

                    // ── Chain analysis ──
                    const loopKey = `${repoKey}:${pr.number}`;

                    // Already disengaged from this PR chain
                    if (this.loopDisengaged.has(loopKey)) {
                        this.logger.debug(`PR #${pr.number}: loop previously detected — skipping`);
                        continue;
                    }

                    const analysis = await this.loopDetector.analyze(
                        forge, pr.number, openPRs,
                    );

                    if (!analysis.shouldEngage) {
                        // Post a one-time loop-detected comment
                        const loopComment = this.loopDetector.generateLoopComment(analysis);
                        const { stamped } = this.stampManager.stampContent(loopComment);
                        await forge.addPRComment(pr.number, stamped);

                        this.loopDisengaged.add(loopKey);
                        this.addActivity(
                            repoKey, undefined, pr.number,
                            '🔄', `Loop detected on PR #${pr.number} — chain: ${analysis.chain.map((n) => `#${n}`).join(' → ')}`,
                        );
                        this.logger.warn(
                            `Disengaging from PR #${pr.number}: ${analysis.reason}`,
                        );
                        continue;
                    }

                    // Log chain info when depth > 0
                    if (analysis.depth > 0) {
                        this.logger.info(
                            `PR #${pr.number}: chain depth ${analysis.depth}/3 ` +
                            `(${analysis.chain.map((n) => `#${n}`).join(' → ')})`,
                        );
                    }

                    const responded = await this.checkOnePRForComments(
                        forge, pr.number, repoKey, analysis,
                    );
                    if (responded) { acknowledged++; }
                } catch (err) {
                    this.logger.error(`Error checking PR #${pr.number}: ${err}`);
                }
            }

            if (acknowledged > 0) {
                this.logger.info(`Acknowledged comments on ${acknowledged} PR(s) in ${repoKey}`);
            }
        } catch (err) {
            this.logger.error(`Failed polling PR comments for ${repoKey}: ${err}`);
        }

        return acknowledged;
    }

    /**
     * Check a single PR for unacknowledged external comments.
     * Returns true if Argus posted a new acknowledgment.
     *
     * Anti-loop protections:
     *  - Chain analysis (via LoopDetector) has already approved engagement.
     *  - Bot noise comments ("I've opened PR #X") are filtered out.
     *  - Inline code-review comments from bots are kept — those ARE useful.
     *  - Only comments NEWER than Argus's last stamp are considered.
     *  - Rate-limited to MAX_ACKS_PER_PR per ACK_WINDOW_MS as a safety net.
     */
    private async checkOnePRForComments(
        forge: Forge,
        prNumber: number,
        repo: RepoKey,
        chainAnalysis: ChainAnalysis,
    ): Promise<boolean> {
        // ── Rate limit check ──
        const ackKey = `${repo}:${prNumber}`;
        const ackRecord = this.ackTracker.get(ackKey);
        if (ackRecord) {
            const elapsed = Date.now() - ackRecord.firstAckAt.getTime();
            if (elapsed < ACK_WINDOW_MS && ackRecord.count >= MAX_ACKS_PER_PR) {
                this.logger.debug(
                    `PR #${prNumber}: rate-limited (${ackRecord.count} acks in ${Math.round(elapsed / 60_000)}m) — skipping`,
                );
                return false;
            }
            // Reset window if expired
            if (elapsed >= ACK_WINDOW_MS) {
                this.ackTracker.delete(ackKey);
            }
        }

        const [conversationComments, reviewComments] = await Promise.all([
            forge.getPRComments(prNumber),
            forge.getPRReviewComments(prNumber),
        ]);

        // Separate Argus's stamped comments from external comments
        const stampedComments = conversationComments.filter(
            (c) => this.stampManager.hasStamp(c.body),
        );

        // Filter external conversation: exclude bot noise (e.g. "I opened PR #X")
        const externalConversation = conversationComments.filter(
            (c) => !this.stampManager.hasStamp(c.body) && !isBotNoise(c.author, c.body),
        );
        // Inline review comments from bots (copilot reviewer) are kept
        const externalReviews = reviewComments.filter(
            (rc) => !this.stampManager.hasStamp(rc.body),
        );

        if (externalConversation.length === 0 && externalReviews.length === 0) {
            return false;
        }

        // Find the timestamp of Argus's latest stamped comment
        let sinceDate: Date | null = null;
        if (stampedComments.length > 0) {
            const latestStamped = stampedComments.reduce((a, b) =>
                a.createdAt > b.createdAt ? a : b,
            );
            sinceDate = latestStamped.createdAt;

            // Only consider comments NEWER than our last stamp
            const newConv = externalConversation.filter((c) => c.createdAt > sinceDate!);
            const newReviews = externalReviews.filter((rc) => rc.createdAt > sinceDate!);

            if (newConv.length === 0 && newReviews.length === 0) {
                this.logger.debug(
                    `PR #${prNumber}: all comments already acknowledged`,
                );
                return false;
            }
        }

        // There are genuinely new, human-authored comments — respond
        this.logger.info(
            `PR #${prNumber}: new unacknowledged feedback detected — responding`,
        );

        // Build a stub TrackedIssue to reuse processNewPRComments
        const stub: TrackedIssue = {
            issueNumber: 0,
            repo,
            title: '',
            url: '',
            state: 'done',
            createdAt: new Date(),
            bodyHash: '',
            currentIteration: 0,
            maxIterations: 0,
            prNumber,
        };

        await this.processNewPRComments(forge, stub, sinceDate);

        // ── Track acknowledgment for rate limiting ──
        const existing = this.ackTracker.get(ackKey);
        if (existing) {
            existing.count++;
            existing.lastAckAt = new Date();
        } else {
            this.ackTracker.set(ackKey, {
                count: 1,
                firstAckAt: new Date(),
                lastAckAt: new Date(),
            });
        }

        this.addActivity(
            repo, undefined, prNumber,
            '👀', `Responded to new comments on PR #${prNumber}`,
        );

        return true;
    }
}
