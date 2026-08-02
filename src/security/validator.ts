// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Output validator — validates LLM-generated code BEFORE it is pushed.
 *
 * Checks for:
 *  - Embedded secrets / tokens
 *  - External network calls (fetch, XMLHttpRequest, etc.)
 *  - Dangerous exec / spawn patterns
 *  - Embedded eval / Function constructors
 *  - Suspiciously large diffs
 *  - Attempts to modify CI configuration
 *  - Attempts to modify security-sensitive files
 */

import { CODE_OUTPUT_DANGER_PATTERNS } from './patterns';

export interface ValidationResult {
    valid: boolean;
    issues: ValidationIssue[];
}

export interface ValidationIssue {
    severity: 'error' | 'warning';
    category: string;
    description: string;
    file?: string;
    line?: number;
    pattern?: string;
}

/** Paths that Argus should never create or modify. */
const FORBIDDEN_PATHS = [
    /^\.github\/workflows\//i,
    /^\.gitlab-ci\.yml$/i,
    /^\.gitlab\/ci\//i,
    /^Jenkinsfile$/i,
    /^\.circleci\//i,
    /^\.travis\.yml$/i,
    /^azure-pipelines\.yml$/i,
    /^Dockerfile$/i,
    /^docker-compose\.yml$/i,
    /^\.env/i,
    /^\.npmrc$/i,
    /^\.yarnrc/i,
    /^\.pypirc$/i,
    /^\.ssh\//i,
    /^\.gnupg\//i,
    /^package-lock\.json$/i,
    /^yarn\.lock$/i,
    /^Gemfile\.lock$/i,
];

/** Patterns that look like embedded secrets. */
const SECRET_PATTERNS = [
    /(?:api[_-]?key|apikey|secret|token|password|passwd|credentials?|auth)\s*[:=]\s*['"][^'"]{8,}/gi,
    /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g,                // GitHub tokens
    /glpat-[A-Za-z0-9_-]{20,}/g,                                     // GitLab tokens
    /sk-[A-Za-z0-9]{20,}/g,                                         // OpenAI-style keys
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,           // PEM keys
    /(?:AKIA|ASIA)[A-Z0-9]{16}/g,                                   // AWS keys
    /xox[bpas]-[A-Za-z0-9-]{10,}/g,                                  // Slack tokens
];

/** Maximum total diff size in characters before warning. */
const MAX_DIFF_SIZE = 50_000;

/** Maximum number of files in a single push. */
const MAX_FILE_COUNT = 30;

export class OutputValidator {
    /**
     * Validate generated file changes before they are pushed.
     * @param files Array of { path, content } to be pushed.
     * @returns ValidationResult with any issues found.
     */
    validate(files: Array<{ path: string; content: string }>): ValidationResult {
        const issues: ValidationIssue[] = [];

        // Check total diff size
        const totalSize = files.reduce((sum, f) => sum + f.content.length, 0);
        if (totalSize > MAX_DIFF_SIZE) {
            issues.push({
                severity: 'warning',
                category: 'size',
                description: `Total diff size ${totalSize} chars exceeds ${MAX_DIFF_SIZE} char limit`,
            });
        }

        // Check file count
        if (files.length > MAX_FILE_COUNT) {
            issues.push({
                severity: 'warning',
                category: 'size',
                description: `Push contains ${files.length} files, exceeding ${MAX_FILE_COUNT} file limit`,
            });
        }

        for (const file of files) {
            // Check forbidden paths
            for (const pattern of FORBIDDEN_PATHS) {
                if (pattern.test(file.path)) {
                    issues.push({
                        severity: 'error',
                        category: 'forbidden_path',
                        description: `Attempting to modify forbidden file: ${file.path}`,
                        file: file.path,
                        pattern: pattern.source,
                    });
                }
            }

            // Check for embedded secrets
            for (const pattern of SECRET_PATTERNS) {
                // Reset lastIndex for global regexes
                pattern.lastIndex = 0;
                const match = pattern.exec(file.content);
                if (match) {
                    const lineNumber = file.content.substring(0, match.index).split('\n').length;
                    issues.push({
                        severity: 'error',
                        category: 'embedded_secret',
                        description: `Possible embedded secret/token in ${file.path}:${lineNumber}`,
                        file: file.path,
                        line: lineNumber,
                        pattern: pattern.source.substring(0, 60),
                    });
                }
            }

            // Check code-level danger patterns
            for (const dp of CODE_OUTPUT_DANGER_PATTERNS) {
                dp.pattern.lastIndex = 0;
                const match = dp.pattern.exec(file.content);
                if (match) {
                    const lineNumber = file.content.substring(0, match.index).split('\n').length;
                    issues.push({
                        severity: dp.severity as 'error' | 'warning',
                        category: dp.name,
                        description: `${dp.name}: ${dp.description} in ${file.path}:${lineNumber}`,
                        file: file.path,
                        line: lineNumber,
                        pattern: match[0].substring(0, 80),
                    });
                }
            }
        }

        return {
            valid: !issues.some((i) => i.severity === 'error'),
            issues,
        };
    }
}
