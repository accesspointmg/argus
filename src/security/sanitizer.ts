// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Input sanitizer — strips known injection patterns, invisible characters,
 * HTML comments, and truncates to safe length before LLM processing.
 *
 * Also hosts `neutralizeForPost`, applied to model-derived text that Argus
 * posts back, so a hostile input can't make Argus @-mention people, render
 * images/links, or inject markup.
 */

import type { SanitizationResult } from './types';
import {
    INJECTION_PATTERNS,
    INVISIBLE_CHAR_PATTERNS,
    HTML_COMMENT_PATTERN,
    BASE64_PAYLOAD_PATTERN,
} from './patterns';
import { readSetting, type SettingReader } from './settings';

const DEFAULT_MAX_LENGTH = 4000;

/** Fake prompt-framing markers an attacker might embed to imitate our boundaries. */
const FRAMING_PATTERN = /\[\s*\/?\s*BOUNDARY[^\]]*\]/gi;

export class Sanitizer {
    /**
     * @param maxLength Fixed limit. When omitted, `argus.security.maxInputLength`
     *                  is read at each call.
     */
    constructor(
        private readonly maxLength?: number,
        private readonly settings: SettingReader = readSetting,
    ) {}

    private limit(): number {
        const n = this.maxLength ?? this.settings('security.maxInputLength', DEFAULT_MAX_LENGTH);
        return Number.isFinite(n) && n >= 100 ? Math.floor(n) : DEFAULT_MAX_LENGTH;
    }

    /**
     * Sanitize untrusted input for safe LLM processing.
     * Does NOT alter the original — returns a sanitized copy.
     */
    sanitize(input: string, maxLength?: number): SanitizationResult {
        const text0 = typeof input === 'string' ? input : '';
        const originalLength = text0.length;
        const strippedPatterns: string[] = [];
        let text = text0;

        // 1. Strip HTML comments (could hide instructions)
        const htmlMatches = text.match(HTML_COMMENT_PATTERN);
        if (htmlMatches) {
            strippedPatterns.push(`html_comments(${htmlMatches.length})`);
            text = text.replace(HTML_COMMENT_PATTERN, '[HTML_COMMENT_REMOVED]');
        }

        // 2. Strip invisible / zero-width characters
        for (const { pattern, name } of INVISIBLE_CHAR_PATTERNS) {
            const fresh = new RegExp(pattern.source, pattern.flags);
            const matches = text.match(fresh);
            if (matches) {
                strippedPatterns.push(`${name}(${matches.length})`);
                text = text.replace(fresh, '');
            }
        }

        // 3. Replace known injection patterns so they can't steer the model;
        //    the names are reported so the classifier can weigh them.
        for (const { pattern, name } of INJECTION_PATTERNS) {
            const fresh = new RegExp(pattern.source, pattern.flags);
            const matches = text.match(fresh);
            if (matches) {
                strippedPatterns.push(`${name}(${matches.length})`);
                text = text.replace(fresh, `[REDACTED:${name}]`);
            }
        }

        // 4. Neutralize anything imitating our prompt framing
        const framing = text.match(FRAMING_PATTERN);
        if (framing) {
            strippedPatterns.push(`framing_marker(${framing.length})`);
            text = text.replace(FRAMING_PATTERN, '[MARKER_REMOVED]');
        }

        // 5. Flag (don't remove) long base64 strings — bug reports carry legit ones
        const b64Matches = text.match(BASE64_PAYLOAD_PATTERN);
        if (b64Matches && b64Matches.some((m) => m.length > 100)) {
            strippedPatterns.push(`base64_payload(${b64Matches.length})`);
        }

        // 6. Truncate
        const max = maxLength ?? this.limit();
        const truncated = text.length > max;
        if (truncated) {
            text = text.substring(0, max) + '\n\n[CONTENT TRUNCATED]';
            strippedPatterns.push(`truncated(${originalLength} → ${max})`);
        }

        return { sanitized: text, strippedPatterns, truncated, originalLength };
    }

    /** Quick check: does this input contain any known injection patterns? */
    hasInjectionPatterns(input: string): boolean {
        return INJECTION_PATTERNS.some(({ pattern }) => new RegExp(pattern.source, pattern.flags).test(input));
    }

    /** Quick check: does this input contain invisible characters? */
    hasInvisibleChars(input: string): boolean {
        return INVISIBLE_CHAR_PATTERNS.some(({ pattern }) => new RegExp(pattern.source, pattern.flags).test(input));
    }
}

/** Pattern names that indicate an attempt to steer the model (not merely odd formatting). */
export const MANIPULATION_PATTERN_PREFIXES = [
    'instruction_override', 'role_switch', 'jailbreak', 'token_injection',
    'role_injection', 'exfiltration', 'privilege_escalation', 'social_engineering',
    'framing_marker',
] as const;

export function hasManipulationPatterns(strippedPatterns: readonly string[]): boolean {
    return strippedPatterns.some((p) => MANIPULATION_PATTERN_PREFIXES.some((m) => p.startsWith(m)));
}

/**
 * Replace invisible / bidi characters with visible `[U+XXXX]` markers so a
 * reviewer (human or model) can see Trojan-Source tricks rather than having
 * them silently removed.
 */
export function revealInvisible(text: string): { text: string; found: number } {
    let found = 0;
    const out = text.replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\u2028\u2029]/g, (c) => {
        found++;
        return `[U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}]`;
    });
    return { text: out, found };
}

/**
 * Make model-derived (and therefore attacker-influenced) text safe to post:
 * no @-mentions, no images, no links, no HTML, no tables breaking out,
 * single line, truncated.
 */
export function neutralizeForPost(text: unknown, maxLength: number = 300): string {
    if (typeof text !== 'string') { return ''; }
    let t = text;
    t = t.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');                 // eslint-disable-line no-control-regex
    t = t.replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '');
    t = t.replace(/<[^>]*>/g, '');                                            // HTML tags / comments
    t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');                           // images → alt text
    t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');                            // links → text
    t = t.replace(/\b(https?|ftp|file|javascript|data):\/*/gi, '$1[:]//');     // defang URLs
    t = t.replace(/@(?=[A-Za-z0-9_-])/g, '@\u200b');                          // break @mentions
    t = t.replace(/#(?=\d)/g, '#\u200b');                                     // break issue cross-links
    t = t.replace(/[|`]/g, (c) => (c === '|' ? '\\|' : "'"));                 // table cells / code spans
    t = t.replace(/\s+/g, ' ').trim();
    if (t.length > maxLength) { t = t.substring(0, maxLength - 1) + '…'; }
    return t;
}
