// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Helpers for text Argus posts publicly.
 *
 * Model output is derived from attacker-controlled issues, so anything the
 * model wrote is treated as untrusted when it is echoed into a comment.
 */

/**
 * Make model-written text safe to embed in a Markdown comment:
 *  - @mentions are broken with a zero-width space so injected text cannot ping
 *    arbitrary users or teams;
 *  - HTML comments are removed (they can hide content from human reviewers and
 *    carry directives aimed at other bots);
 *  - length is capped.
 */
export function neutralizeModelText(text: string, maxLength = 4000): string {
    const cleaned = removeUntilStable(String(text ?? ''), /<!--[\s\S]*?-->/g)
        // Anything left (an unclosed or reassembled opener) is shown, not interpreted.
        .replace(/<!--/g, '&lt;!--')
        .replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, '$1@​');
    return truncate(cleaned, maxLength);
}

/**
 * Apply a removal until the text stops changing. A single pass is not enough:
 * removing `<!--x-->` from `<!<!--x-->-- hidden -->` reassembles a comment.
 */
export function removeUntilStable(text: string, pattern: RegExp): string {
    let previous: string;
    let current = text;
    do {
        previous = current;
        current = current.replace(pattern, '');
    } while (current !== previous);
    return current;
}

/** Inline-code a value that may contain backticks. */
export function inlineCode(value: string): string {
    const v = String(value ?? '').replace(/[\r\n]+/g, ' ');
    const fence = v.includes('`') ? '``' : '`';
    return `${fence}${v}${fence}`;
}

export function truncate(text: string, maxLength: number): string {
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** Collapse a value to a single short line for logs and activity entries. */
export function oneLine(text: string, maxLength = 120): string {
    return truncate(String(text ?? '').replace(/\s+/g, ' ').trim(), maxLength);
}
