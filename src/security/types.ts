// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Security types — threat classification, trust model, audit log.
 */

// ─── Threat Classification ──────────────────────────────────────────

export type ThreatType =
    | 'prompt_injection'
    | 'jailbreak_attempt'
    | 'social_engineering'
    | 'context_manipulation'
    | 'data_exfiltration'
    | 'code_injection'
    | 'privilege_escalation'
    | 'delayed_payload';

export type ThreatClassification = 'clean' | 'suspicious' | 'hostile';

export interface ThreatAssessment {
    classification: ThreatClassification;
    confidence: number;          // 0.0 - 1.0
    threatType?: ThreatType;
    evidence: string[];
    rawInput: string;            // Preserved for audit
}

// ─── Trust Model ────────────────────────────────────────────────────

export type TrustTier =
    | 'owner'
    | 'maintainer'
    | 'reviewer'
    | 'contributor'
    | 'participant'
    | 'unknown';

export const BASE_TRUST_SCORES: Record<TrustTier, number> = {
    owner: 1.0,
    maintainer: 0.85,
    reviewer: 0.75,
    contributor: 0.5,
    participant: 0.3,
    unknown: 0.0,
};

export interface UserTrustProfile {
    username: string;
    tier: TrustTier;
    baseTrustScore: number;
    historyModifier: number;      // -0.3 to +0.2
    effectiveTrustScore: number;  // Clamped [0.0, 1.0]
    repoRole: string;
    history: {
        mergedPRs: number;
        closedIssuesAsValid: number;
        previousFlags: number;
        previousBlocks: number;
        totalComments: number;
        accountAge?: Date;
    };
    lastUpdated: Date;
}

export interface ThreatThresholds {
    flagThreshold: number;
    blockThreshold: number;
    reportThreshold: number;
}

/**
 * Compute dynamic threat thresholds based on trust score.
 * Higher trust → harder to flag/block/report.
 */
export function computeThresholds(trustScore: number): ThreatThresholds {
    return {
        flagThreshold: 0.5 + (trustScore * 0.3),     // 0.5 (unknown) → 0.8 (owner)
        blockThreshold: 0.8 + (trustScore * 0.19),    // 0.8 (unknown) → 0.99 (owner)
        reportThreshold: trustScore >= 0.75 ? Infinity : 0.95,
    };
}

// ─── Diff Assessment ────────────────────────────────────────────────

/** Categories of files that form the execution surface of a repository. */
export type ExecutionSurfaceCategory =
    | 'ci_workflow'     // .github/workflows/**, .gitlab-ci.yml, Jenkinsfile, etc.
    | 'build_system'    // CMakeLists.txt, *.cmake, Makefile, setup.py, meson.build
    | 'dependency'      // package.json, lockfiles, requirements.txt, Gemfile
    | 'container'       // Dockerfile, docker-compose.yml
    | 'git_config'      // .gitmodules, .gitattributes (filter drivers execute on checkout)
    | 'script';         // *.sh, *.ps1, *.bat in build-relevant paths

/** A single file change that touches the execution surface. */
export interface ExecutionSurfaceChange {
    path: string;
    category: ExecutionSurfaceCategory;
    risk: 'critical' | 'high' | 'medium' | 'low';
    detail: string;
}

/** Verdict the diff assessor produces. */
export type DiffVerdict = 'pass' | 'fail' | 'review';

/** Full result of assessing a PR's diff for threats. */
export interface DiffAssessment {
    verdict: DiffVerdict;
    confidence: number;             // 0.0–1.0
    executionSurfaceChanges: ExecutionSurfaceChange[];
    authorTrust: UserTrustProfile;
    reasoning: string;
    evidence: string[];
    assessedAt: Date;
    commitSha: string;
    /** Number of LLM calls consumed (0 when fast-pathed). */
    llmCalls: number;
}

// ─── Sanitization ───────────────────────────────────────────────────

export interface SanitizationResult {
    sanitized: string;
    strippedPatterns: string[];
    truncated: boolean;
    originalLength: number;
}

// ─── Audit Log ──────────────────────────────────────────────────────

export type AuditAction =
    | 'poll_repos'
    | 'evaluate_issue'
    | 'approve_issue'
    | 'reject_issue'
    | 'flag_issue'
    | 'post_comment'
    | 'create_branch'
    | 'push_code'
    | 'create_pr'
    | 'evaluate_comment'
    | 'flag_comment'
    | 'delete_comment'
    | 'block_user'
    | 'unblock_user'
    | 'report_user'
    | 'evaluate_competing_pr'
    | 'create_synthesis_pr'
    | 'detect_tamper'
    | 'detect_edit'
    | 'emergency_stop'
    | 'send_email'
    | 'key_rotation'
    | 'ci_check'
    | 'watchdog_timeout'
    | 'assess_diff'
    | 'gate_pr';

export interface AuditEntry {
    id: string;           // Sequential: "00000001"
    timestamp: string;    // ISO 8601
    action: AuditAction;
    repo: string;
    target: string;       // Issue/PR/comment URL
    inputHash: string;    // SHA-256 of the full input
    outputHash: string;   // SHA-256 of the full output
    decision: string;
    llmCallCount: number;
    details: string;      // Human-readable summary
    previousEntryHash: string;  // Chain link
    signature: string;    // HMAC-SHA256
}
