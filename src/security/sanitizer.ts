// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Input sanitizer — strips known injection patterns, invisible characters,
 * HTML comments, and truncates to safe length before LLM processing.
 */

import type { SanitizationResult } from './types';
import {
    INJECTION_PATTERNS,
    INVISIBLE_CHAR_PATTERNS,
    HTML_COMMENT_PATTERN,
    BASE64_PAYLOAD_PATTERN,
} from './patterns';

const DEFAULT_MAX_LENGTH = 4000;

export class Sanitizer {
    constructor(private readonly maxLength: number = DEFAULT_MAX_LENGTH) {}

    /**
     * Sanitize untrusted input for safe LLM processing.
     * Does NOT alter the original — returns a sanitized copy.
     */
    sanitize(input: string): SanitizationResult {
        const originalLength = input.length;
        const strippedPatterns: string[] = [];
        let text = input;

        // 1. Strip HTML comments (could hide instructions)
        const htmlMatches = text.match(HTML_COMMENT_PATTERN);
        if (htmlMatches) {
            strippedPatterns.push(`html_comments(${htmlMatches.length})`);
            text = text.replace(HTML_COMMENT_PATTERN, '[HTML_COMMENT_REMOVED]');
        }

        // 2. Strip invisible / zero-width characters
        for (const { pattern, name } of INVISIBLE_CHAR_PATTERNS) {
            const matches = text.match(pattern);
            if (matches) {
                strippedPatterns.push(`${name}(${matches.length})`);
                text = text.replace(pattern, '');
            }
        }

        // 3. Flag (but don't remove) known injection patterns
        // We flag them so the threat classifier can use this information,
        // but we replace them so they can't influence the LLM
        for (const { pattern, name } of INJECTION_PATTERNS) {
            // Reset lastIndex for global patterns
            const fresh = new RegExp(pattern.source, pattern.flags);
            const matches = text.match(fresh);
            if (matches) {
                strippedPatterns.push(`${name}(${matches.length})`);
                text = text.replace(fresh, `[REDACTED:${name}]`);
            }
        }

        // 4. Flag suspiciously long base64 strings
        const b64Matches = text.match(BASE64_PAYLOAD_PATTERN);
        if (b64Matches && b64Matches.some((m) => m.length > 100)) {
            strippedPatterns.push(`base64_payload(${b64Matches.length})`);
            // Don't remove — some legitimate content has base64 (e.g., encoded data in bug reports)
            // But flag it for the threat classifier
        }

        // 5. Truncate to max length
        const truncated = text.length > this.maxLength;
        if (truncated) {
            text = text.substring(0, this.maxLength) + '\n\n[CONTENT TRUNCATED]';
            strippedPatterns.push(`truncated(${originalLength} → ${this.maxLength})`);
        }

        return {
            sanitized: text,
            strippedPatterns,
            truncated,
            originalLength,
        };
    }

    /** Quick check: does this input contain any known injection patterns? */
    hasInjectionPatterns(input: string): boolean {
        for (const { pattern } of INJECTION_PATTERNS) {
            const fresh = new RegExp(pattern.source, pattern.flags);
            if (fresh.test(input)) {
                return true;
            }
        }
        return false;
    }

    /** Quick check: does this input contain invisible characters? */
    hasInvisibleChars(input: string): boolean {
        for (const { pattern } of INVISIBLE_CHAR_PATTERNS) {
            if (pattern.test(input)) {
                return true;
            }
        }
        return false;
    }
}
