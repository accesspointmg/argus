// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Agent types — issue processing pipeline, PR analysis, session management.
 */

import type { RepoKey } from '../forge/types';

// ─── Issue Pipeline States ──────────────────────────────────────────

export type IssueState =
    | 'pending'
    | 'evaluating'
    /** Evaluated with merit, but the author is not trusted to trigger code generation. */
    | 'awaiting-approval'
    | 'approved'
    | 'rejected'
    | 'branching'
    | 'coding'
    | 'waiting-ci'
    | 'iterating'
    | 'pr-open'
    | 'analyzing-competing'
    | 'synthesizing'
    | 'stuck'
    | 'flagged'
    | 'done'
    | 'skipped';

/** A tracked issue in Argus's work queue. */
export interface TrackedIssue {
    issueNumber: number;
    repo: RepoKey;
    title: string;
    url: string;
    state: IssueState;
    createdAt: Date;
    startedAt?: Date;
    completedAt?: Date;
    /** SHA-256 of the body Argus evaluated; later edits are detected against it. */
    bodyHash: string;
    author?: string;
    /** Trusted user whose `/argus fix` comment authorized code generation. */
    approvedBy?: string;
    /**
     * When the body matching `bodyHash` was first seen. Approvals posted before
     * this don't count: they approved a different text.
     */
    bodySeenAt?: Date;
    branchName?: string;
    prNumber?: number;
    prUrl?: string;
    synthesisPrNumber?: number;
    synthesisPrUrl?: string;
    currentIteration: number;
    maxIterations: number;
    evaluation?: IssueEvaluation;
    competingPRs?: PRAnalysis[];
    error?: string;
}

// ─── Issue Evaluation ───────────────────────────────────────────────

export interface IssueEvaluation {
    merit: boolean;
    confidence: number;
    reasoning: string;
    suggestedLabels: string[];
    affectedFiles: string[];
    proposedApproach: string;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'trivial';
    category: 'bug' | 'feature' | 'improvement' | 'docs' | 'question' | 'duplicate' | 'invalid';
    duplicateOf?: number;
    /**
     * Set when the evaluation itself failed (model error, missing canary,
     * unparseable reply). Such evaluations always carry `merit: false` and
     * must be routed to a human, never acted on.
     */
    reviewRequired?: boolean;
}

export const SEVERITIES: readonly IssueEvaluation['severity'][] = ['critical', 'high', 'medium', 'low', 'trivial'];
export const CATEGORIES: readonly IssueEvaluation['category'][] = [
    'bug', 'feature', 'improvement', 'docs', 'question', 'duplicate', 'invalid',
];

// ─── Comment Evaluation ─────────────────────────────────────────────

export interface CommentEvaluation {
    isRelevant: boolean;
    hasNewInformation: boolean;
    suggestsCorrection: boolean;
    sentiment: 'constructive' | 'neutral' | 'unconstructive';
    actionItems: string[];
    shouldUpdatePR: boolean;
}

// ─── PR Analysis ────────────────────────────────────────────────────

export interface PRAnalysis {
    prId: string;
    prNumber: number;
    prUrl: string;
    author: string;
    trustScore: number;
    isOurInstance: boolean;
    isOtherArgus: boolean;

    // Technical merit scores (0.0 - 1.0)
    correctness: number;
    completeness: number;
    codeQuality: number;
    testCoverage: number;
    minimalInvasiveness: number;
    ciPassing: boolean;

    // Composite
    overallScore: number;

    // Qualitative
    strengths: string[];
    weaknesses: string[];
    novelInsights: string[];
    risksIntroduced: string[];

    // Relative to our PR
    overlapWithOurs: number;
    uniqueContributions: string[];
}

export interface SynthesisCandidate {
    sourcePRs: PRAnalysis[];
    elementsFromEach: {
        prNumber: number;
        elements: string[];
        reason: string;
    }[];
    projectedScore: number;
    conflictsToResolve: string[];
}

// ─── Coding Iteration ───────────────────────────────────────────────

export interface CodingIteration {
    iteration: number;
    filesChanged: { path: string; linesAdded: number; linesRemoved: number }[];
    commitMessage: string;
    reasoning: string;
    selfReview: string;
    /** `none` = the repo reported no CI at all; `pending` = CI did not finish in time. */
    ciResult?: 'pending' | 'passing' | 'failing' | 'none';
    /** Commit created by this iteration. */
    commitSha?: string;
    ciLog?: string;
}

// ─── Activity Log Entry ─────────────────────────────────────────────

export interface ActivityEntry {
    timestamp: Date;
    repo: RepoKey;
    issueNumber?: number;
    prNumber?: number;
    icon: string;
    message: string;
    url?: string;
}

// ─── Repo Statistics ────────────────────────────────────────────────

export interface RepoStats {
    repo: RepoKey;
    openIssues: number;
    argusTriaged: number;
    prsOpened: number;
    prsMergedByHumans: number;
    avgTimeToPR: number;         // milliseconds
    avgCIIterations: number;
    rejectionRate: number;       // 0.0 - 1.0
    threatDetections: number;
    synthesisPRs: number;
}
