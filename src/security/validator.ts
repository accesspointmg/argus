// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Output validator — validates LLM-generated file changes BEFORE they are pushed.
 *
 * Errors (push refused):
 *  - Paths that are not clean repo-relative paths (absolute, `..`, backslash,
 *    drive letter, NUL/control/invisible characters, trailing dot/space)
 *  - Execution-surface files at any depth (shared list with the diff assessor)
 *  - Paths outside the optional `allowedPaths` allow-list
 *  - Embedded secrets / tokens
 *  - Process execution, dynamic evaluation, network calls
 *
 * Warnings: oversized pushes, obfuscation signals.
 *
 * When the original content of a file is supplied, code patterns are checked
 * only on lines the change ADDS, so pre-existing code doesn't block a fix.
 */

import { CODE_OUTPUT_DANGER_PATTERNS } from './patterns';
import { globToRegExp, matchExecutionSurface, normalizeRepoPath } from './execution-surface';

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

/** A proposed change. `content: null` deletes the file. */
export interface ProposedFile {
    path: string;
    content: string | null;
    /** Current content on the base branch, if the file exists. */
    original?: string;
}

export interface ValidateOptions {
    /**
     * Glob allow-list (`src/**`, `docs/*.md`). When non-empty, every path must
     * match one entry. It narrows, never widens: execution-surface paths stay
     * forbidden even if allowed here.
     */
    allowedPaths?: readonly string[];
}

/** Patterns that look like embedded secrets. */
const SECRET_PATTERNS = [
    /(?:api[_-]?key|apikey|secret|token|password|passwd|credentials?|auth)\s*[:=]\s*['"][^'"]{8,}/gi,
    /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g,                // GitHub tokens
    /github_pat_[A-Za-z0-9_]{40,}/g,                              // GitHub fine-grained tokens
    /glpat-[A-Za-z0-9_-]{20,}/g,                                  // GitLab tokens
    /sk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,                            // OpenAI / Anthropic-style keys
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g, // PEM keys
    /(?:AKIA|ASIA)[A-Z0-9]{16}/g,                                 // AWS keys
    /xox[bpas]-[A-Za-z0-9-]{10,}/g,                               // Slack tokens
    /AIza[0-9A-Za-z_-]{35}/g,                                     // Google API keys
];

/** Maximum total content size in characters before warning. */
const MAX_DIFF_SIZE = 50_000;

/** Maximum number of files in a single push. */
const MAX_FILE_COUNT = 30;

export class OutputValidator {
    /**
     * Validate generated file changes before they are pushed.
     * Accepts `{ path, content }` (legacy shape) or {@link ProposedFile}.
     */
    validate(files: ReadonlyArray<ProposedFile>, options: ValidateOptions = {}): ValidationResult {
        const issues: ValidationIssue[] = [];
        const allow = (options.allowedPaths ?? []).filter((g) => g.trim() !== '').map(globToRegExp);

        const totalSize = files.reduce((sum, f) => sum + (f.content?.length ?? 0), 0);
        if (totalSize > MAX_DIFF_SIZE) {
            issues.push({
                severity: 'warning',
                category: 'size',
                description: `Total change size ${totalSize} chars exceeds ${MAX_DIFF_SIZE} char limit`,
            });
        }
        if (files.length > MAX_FILE_COUNT) {
            issues.push({
                severity: 'warning',
                category: 'size',
                description: `Push contains ${files.length} files, exceeding ${MAX_FILE_COUNT} file limit`,
            });
        }

        const seen = new Set<string>();
        for (const file of files) {
            const norm = normalizeRepoPath(file.path);
            if (!norm.ok) {
                issues.push({
                    severity: 'error',
                    category: 'invalid_path',
                    description: `Rejected path (${norm.reason}): ${JSON.stringify(file.path).substring(0, 120)}`,
                    file: file.path,
                });
                continue;
            }
            const path = norm.path;

            // Case-insensitive duplicates alias each other on Windows/macOS checkouts.
            const key = path.toLowerCase();
            if (seen.has(key)) {
                issues.push({ severity: 'error', category: 'invalid_path', description: `Duplicate path: ${path}`, file: path });
            }
            seen.add(key);

            const surface = matchExecutionSurface(path);
            if (surface) {
                issues.push({
                    severity: 'error',
                    category: 'forbidden_path',
                    description: `Attempting to ${file.content === null ? 'delete' : 'modify'} execution-surface file: ${path} (${surface.detail})`,
                    file: path,
                    pattern: surface.pattern.source,
                });
            }

            if (allow.length > 0 && !allow.some((re) => re.test(path))) {
                issues.push({
                    severity: 'error',
                    category: 'not_allowed_path',
                    description: `Path is outside the allowed paths: ${path}`,
                    file: path,
                });
            }

            if (file.content === null) { continue; }

            const scan = addedText(file.content, file.original);

            for (const pattern of SECRET_PATTERNS) {
                const match = new RegExp(pattern.source, pattern.flags).exec(scan.text);
                if (match) {
                    const line = scan.lineOf(match.index);
                    issues.push({
                        severity: 'error',
                        category: 'embedded_secret',
                        description: `Possible embedded secret/token in ${path}:${line}`,
                        file: path,
                        line,
                        pattern: pattern.source.substring(0, 60),
                    });
                }
            }

            for (const dp of CODE_OUTPUT_DANGER_PATTERNS) {
                const match = new RegExp(dp.pattern.source, dp.pattern.flags).exec(scan.text);
                if (match) {
                    const line = scan.lineOf(match.index);
                    issues.push({
                        severity: dp.severity,
                        category: dp.name,
                        description: `${dp.name}: ${dp.description} in ${path}:${line}`,
                        file: path,
                        line,
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

/**
 * The text to scan for code patterns: the whole file when it is new, else
 * only lines not present in the original (multiset line diff — cheap and
 * conservative: a moved line is not "added", a modified line is).
 */
function addedText(content: string, original: string | undefined): { text: string; lineOf(index: number): number } {
    if (original === undefined) {
        return { text: content, lineOf: (i) => content.substring(0, i).split('\n').length };
    }
    const pool = new Map<string, number>();
    for (const l of original.split('\n')) { pool.set(l, (pool.get(l) ?? 0) + 1); }

    const lines = content.split('\n');
    const kept: string[] = [];
    const lineNumbers: number[] = [];
    lines.forEach((l, idx) => {
        const n = pool.get(l) ?? 0;
        if (n > 0) { pool.set(l, n - 1); return; }
        kept.push(l);
        lineNumbers.push(idx + 1);
    });
    const text = kept.join('\n');
    return {
        text,
        lineOf: (i) => lineNumbers[text.substring(0, i).split('\n').length - 1] ?? 1,
    };
}
