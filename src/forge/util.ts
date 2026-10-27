// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Pure helpers shared by the forge implementations.
 */

/**
 * True when `text` references issue `n` as a whole token: `#12` matches, but
 * `#123`, `#12a`, `abc#12` and cross-repo `other/repo#12` do not.
 * Covers `closes/fixes/resolves #N` since those contain the token.
 */
export function referencesIssue(text: string, n: number): boolean {
    if (!Number.isInteger(n) || n <= 0) { return false; }
    return new RegExp(`(?<![\\w/.\\-])#${n}(?![\\w])`).test(text);
}

/** True when `branch` looks like an Argus branch for issue `n` (`<prefix>issue-N`). */
export function isIssueBranch(branch: string, n: number): boolean {
    return new RegExp(`(?:^|/)issue-${n}$`).test(branch);
}

/** Title prefixes GitHub/GitLab users use to mark work in progress. */
export function hasDraftTitle(title: string): boolean {
    return /^\s*(?:\[(?:wip|draft)\]|\((?:wip|draft)\)|(?:wip|draft)\s*:)/i.test(title);
}

/** Count added/removed lines in a unified diff body (headers excluded). */
export function countDiffLines(patch: string | undefined): { additions: number; deletions: number } {
    let additions = 0;
    let deletions = 0;
    if (!patch) { return { additions, deletions }; }
    for (const line of patch.split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---')) { continue; }
        if (line.startsWith('+')) { additions++; }
        else if (line.startsWith('-')) { deletions++; }
    }
    return { additions, deletions };
}

/**
 * Remove search qualifiers that would widen a scoped code search to other
 * repositories (`repo:`, `org:`, `user:`). The query is model-generated from
 * untrusted text.
 */
export function stripScopeQualifiers(query: string): string {
    return query.replace(/(?:^|\s)-?(?:repo|org|user|owner|enterprise):\S+/gi, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Base URL for a host: GitHub Enterprise API root (`/api/v3`) or GitLab instance root.
 * Returns undefined for the public SaaS host. `host` is a bare hostname (optionally with
 * port / path prefix); a scheme is tolerated but must be https — tokens are sent
 * on every request.
 */
export function baseUrlForHost(platform: 'github' | 'gitlab', host?: string): string | undefined {
    if (!host || !host.trim()) { return undefined; }
    let h = host.trim();
    if (/^http:\/\//i.test(h)) {
        throw new Error(`Refusing plain-http forge host "${host}": tokens would be sent unencrypted. Use https.`);
    }
    h = h.replace(/^https:\/\//i, '').replace(/\/+$/, '');
    if (!/^[a-z0-9.-]+(?::\d{1,5})?(?:\/[\w.~-]+)*$/i.test(h)) {
        throw new Error(`Invalid forge host "${host}"`);
    }
    const lower = h.toLowerCase();
    if (platform === 'github') {
        return lower === 'github.com' || lower === 'api.github.com' ? undefined : `https://${h}/api/v3`;
    }
    return lower === 'gitlab.com' ? undefined : `https://${h}`;
}
