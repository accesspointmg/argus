// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Agent types — issue processing pipeline, PR analysis, session management.
 */

import type { RepoKey } from '../forge/types';

// ─── Issue Pipeline States ──────────────────────────────────────────

export type IssueState =
    | 'pending'
    | 'evaluating'
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
    bodyHash: string;              // SHA-256 for edit detection
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
}

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

// ─── Session Isolation ──────────────────────────────────────────────

export interface IssueSession {
    issueNumber: number;
    repo: RepoKey;
    startedAt: Date;
    llmConversationHistory: never[]; // Never shared — always empty on creation
    filesRead: string[];
    filesModified: string[];
    stampsGenerated: string[];
    noncesUsed: string[];
    llmCallCount: number;
    aborted: boolean;
    abortReason?: string;
}

// ─── Coding Iteration ───────────────────────────────────────────────

export interface CodingIteration {
    iteration: number;
    filesChanged: { path: string; linesAdded: number; linesRemoved: number }[];
    commitMessage: string;
    reasoning: string;
    selfReview: string;
    ciResult?: 'pending' | 'passing' | 'failing';
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
