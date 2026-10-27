// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

export { Sanitizer, neutralizeForPost, revealInvisible, hasManipulationPatterns } from './sanitizer';
export { ThreatClassifier } from './threat-classifier';
export { TrustManager, TrustResolver, computeHistoryModifier } from './trust';
export { OutputValidator, type ValidationResult, type ValidationIssue, type ProposedFile, type ValidateOptions } from './validator';
export { DiffAssessor, type AssessOptions } from './diff-assessor';
export {
    EXECUTION_SURFACE_RULES,
    matchExecutionSurface,
    isExecutionSurface,
    classifyPaths,
    normalizeRepoPath,
    globToRegExp,
    type SurfaceRule,
    type NormalizedPath,
} from './execution-surface';
export { resolveOwnership, type Ownership, type StampedItem } from './sovereignty';
export { newFrame, type Frame } from './framing';
export { readSetting, fixedSettings, type SettingReader } from './settings';
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
