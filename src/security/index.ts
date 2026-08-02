// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

export { Sanitizer } from './sanitizer';
export { ThreatClassifier } from './threat-classifier';
export { TrustResolver } from './trust';
export { OutputValidator, type ValidationResult, type ValidationIssue } from './validator';
export { DiffAssessor } from './diff-assessor';
export {
    INJECTION_PATTERNS,
    INVISIBLE_CHAR_PATTERNS,
    HTML_COMMENT_PATTERN,
    BASE64_PAYLOAD_PATTERN,
    CODE_OUTPUT_DANGER_PATTERNS,
} from './patterns';
export {
    type ThreatAssessment,
    type ThreatClassification,
    type ThreatType,
    type TrustTier,
    type UserTrustProfile,
    type ThreatThresholds,
    type SanitizationResult,
    type ExecutionSurfaceCategory,
    type ExecutionSurfaceChange,
    type DiffVerdict,
    type DiffAssessment,
    type AuditEntry,
    type AuditAction,
    BASE_TRUST_SCORES,
    computeThresholds,
} from './types';
