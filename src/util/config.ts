// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Config — reads Argus settings.
 *
 * Every setting is application-scoped (see package.json), so a cloned repo's
 * `.vscode/settings.json` cannot change where Argus sends keys or what it
 * pushes. Call {@link readConfig} at the point of use rather than caching the
 * result: settings changes then apply on the next poll without a restart.
 */

import * as vscode from 'vscode';
import type { RepoConfig, RepoEmailConfig, ForgePlatform, RepoKey } from '../forge/types';
import { repoKey } from '../forge/types';
import type { LogLevel } from './logger';
import type { EmailConfig, RepoEmailOverride } from '../notifications/email';

export interface LabelConfig {
    approved: string;
    rejected: string;
    needsReview: string;
    subversionDetected: string;
}

export interface CommentConfig {
    processIssueComments: boolean;
    processPRComments: boolean;
    processPRReviews: boolean;
}

export interface RateLimitConfig {
    commentsPerHour: number;
    branchesPerHour: number;
    prsPerHour: number;
    pushesPerHour: number;
    blocksPerDay: number;
    llmCallsPerHour: number;
    issuesPerHour: number;
    queueDepth: number;
}

export interface PRAnalysisConfig {
    enabled: boolean;
    synthesisEnabled: boolean;
}

export type EmailEventName =
    | 'prOpened'
    | 'prStuck'
    | 'ciPassedFinal'
    | 'threatDetected'
    | 'userBlocked'
    | 'emergencyStop'
    | 'rateLimitWarning'
    | 'anomalyDetected'
    | 'systemError';

export interface EmailPolicy {
    events: Partial<Record<EmailEventName, { enabled?: boolean }>>;
    quietHours?: { start: string; end: string; timezone: string };
}

export interface ArgusConfig {
    repos: RepoConfig[];
    defaultPollIntervalMinutes: number;
    maxConcurrentIssues: number;
    maxIterations: number;
    maxDiffLines: number;
    branchPrefix: string;
    dryRun: boolean;
    autoStartOnActivation: boolean;
    watchdogTimeoutMinutes: number;
    logLevel: LogLevel;
    labels: LabelConfig;
    comments: CommentConfig;
    rateLimits: RateLimitConfig;
    prAnalysis: PRAnalysisConfig;
    email: EmailConfig;
    emailPolicy: EmailPolicy;
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Path segments after `owner/repo` on github.com pages that aren't part of the repo name. */
const GITHUB_SUBPAGES = new Set(['issues', 'pull', 'pulls', 'tree', 'blob', 'commit', 'commits', 'actions', 'wiki', 'releases', 'discussions']);

export function readConfig(): ArgusConfig {
    const cfg = vscode.workspace.getConfiguration('argus');
    const num = (key: string, fallback: number, min = 0): number => {
        const v = cfg.get<number>(key, fallback);
        return typeof v === 'number' && Number.isFinite(v) && v >= min ? v : fallback;
    };
    const str = (key: string, fallback: string): string => {
        const v = cfg.get<string>(key, fallback);
        return typeof v === 'string' && v.trim() ? v.trim() : fallback;
    };

    const defaultInterval = num('pollIntervalMinutes', 5, 1);
    const repoEntries = cfg.get<unknown[]>('repos', []);
    const repos = (Array.isArray(repoEntries) ? repoEntries : [])
        .map((r) => parseRepoEntry(r, defaultInterval))
        .filter((r): r is RepoConfig => r !== null);

    const smtpObj = asRecord(cfg.get('email.smtp', {}));
    const email: EmailConfig = {
        enabled: cfg.get<boolean>('email.enabled', false) === true,
        smtp: {
            host: typeof smtpObj.host === 'string' ? smtpObj.host : '',
            port: typeof smtpObj.port === 'number' ? smtpObj.port : 587,
            secure: smtpObj.secure === true,
            user: typeof smtpObj.user === 'string' ? smtpObj.user : '',
            pass: '', // injected from SecretStorage by the caller
        },
        fromAddress: cfg.get<string>('email.fromAddress', ''),
        fromName: cfg.get<string>('email.fromName', 'Argus'),
        defaultRecipients: stringArray(cfg.get('email.defaultRecipients', [])),
        repoOverrides: buildRepoEmailOverrides(repos),
    };

    const logLevel = cfg.get<string>('logLevel', 'info') as LogLevel;

    return {
        repos,
        defaultPollIntervalMinutes: defaultInterval,
        maxConcurrentIssues: num('maxConcurrentIssues', 1, 1),
        maxIterations: num('maxIterations', 5, 1),
        maxDiffLines: num('maxDiffLines', 500, 1),
        branchPrefix: sanitizeBranchPrefix(str('branchPrefix', 'ai-fix/')),
        dryRun: cfg.get<boolean>('dryRun', false) === true,
        autoStartOnActivation: cfg.get<boolean>('autoStartOnActivation', false) === true,
        watchdogTimeoutMinutes: num('watchdogTimeoutMinutes', 30, 1),
        logLevel: LOG_LEVELS.includes(logLevel) ? logLevel : 'info',
        labels: {
            approved: str('labels.approved', 'ai-triaged'),
            rejected: str('labels.rejected', 'ai-rejected'),
            needsReview: str('labels.needsReview', 'needs-human-review'),
            subversionDetected: str('labels.subversionDetected', 'subversion-detected'),
        },
        comments: {
            processIssueComments: cfg.get<boolean>('comments.processIssueComments', true) !== false,
            processPRComments: cfg.get<boolean>('comments.processPRComments', true) !== false,
            processPRReviews: cfg.get<boolean>('comments.processPRReviews', true) !== false,
        },
        rateLimits: {
            commentsPerHour: num('rateLimits.commentsPerHour', 30),
            branchesPerHour: num('rateLimits.branchesPerHour', 10),
            prsPerHour: num('rateLimits.prsPerHour', 5),
            pushesPerHour: num('rateLimits.pushesPerHour', 20),
            blocksPerDay: num('rateLimits.blocksPerDay', 3),
            llmCallsPerHour: num('rateLimits.llmCallsPerHour', 100),
            issuesPerHour: num('rateLimits.issuesPerHour', 10),
            queueDepth: num('rateLimits.queueDepth', 50, 1),
        },
        prAnalysis: {
            enabled: cfg.get<boolean>('prAnalysis.enabled', true) !== false,
            synthesisEnabled: cfg.get<boolean>('prAnalysis.synthesisEnabled', true) !== false,
        },
        email,
        emailPolicy: {
            events: asRecord(cfg.get('email.events', {})) as EmailPolicy['events'],
            quietHours: parseQuietHours(cfg.get('email.quietHours')),
        },
    };
}

/**
 * Branch names end up in git refs and API paths. Keep the prefix to a
 * conservative character set so a typo can't produce an invalid ref.
 */
function sanitizeBranchPrefix(prefix: string): string {
    const cleaned = prefix.replace(/[^A-Za-z0-9._/-]/g, '-').replace(/\.\.+/g, '.').replace(/^\/+/, '');
    return cleaned || 'ai-fix/';
}

function parseQuietHours(raw: unknown): EmailPolicy['quietHours'] {
    const r = asRecord(raw);
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (typeof r.start === 'string' && typeof r.end === 'string' && hhmm.test(r.start) && hhmm.test(r.end)) {
        return { start: r.start, end: r.end, timezone: typeof r.timezone === 'string' ? r.timezone : 'UTC' };
    }
    return undefined;
}

function asRecord(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function stringArray(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

/**
 * Parse a repo entry from settings. Accepts a string (any format
 * {@link parseRepoInput} accepts) or an object:
 * `{ repo: "owner/repo", host?: "gitlab.example.com", pollIntervalMinutes?: 10, email?: {...} }`.
 */
export function parseRepoEntry(input: unknown, defaultInterval: number = 5): RepoConfig | null {
    if (typeof input === 'string') {
        return parseRepoInput(input, defaultInterval);
    }
    const obj = asRecord(input);
    const repoStr = typeof obj.repo === 'string' ? obj.repo : typeof obj.url === 'string' ? obj.url : '';
    const parsed = parseRepoInput(repoStr, defaultInterval);
    if (!parsed) { return null; }

    if (typeof obj.host === 'string' && obj.host.trim()) {
        parsed.host = normalizeHost(obj.host);
    }
    if (typeof obj.pollIntervalMinutes === 'number' && obj.pollIntervalMinutes >= 1) {
        parsed.pollIntervalMinutes = obj.pollIntervalMinutes;
    }

    const emailObj = asRecord(obj.email);
    if (Object.keys(emailObj).length > 0) {
        const email: RepoEmailConfig = {};
        const recipients = stringArray(emailObj.recipients);
        if (recipients.length) { email.recipients = recipients; }
        const smtp = asRecord(emailObj.smtp);
        if (Object.keys(smtp).length > 0) {
            email.smtp = {
                host: typeof smtp.host === 'string' ? smtp.host : undefined,
                port: typeof smtp.port === 'number' ? smtp.port : undefined,
                secure: typeof smtp.secure === 'boolean' ? smtp.secure : undefined,
                user: typeof smtp.user === 'string' ? smtp.user : undefined,
            };
        }
        parsed.email = email;
    }
    return parsed;
}

function normalizeHost(host: string): string {
    return host.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}

/**
 * Parse any repo input format:
 *   - `https://github.com/owner/repo(.git)`, `git@github.com:owner/repo.git`
 *   - `https://gitlab.example.com/group/subgroup/repo` (self-hosted GitLab, nested groups)
 *   - `https://ghe.example.com/owner/repo` is treated as GitHub Enterprise only via
 *     the object form with an explicit `host`; bare unknown hosts default to GitLab
 *     when the hostname contains "gitlab", otherwise GitHub.
 *   - `github:owner/repo`, `gitlab:group/repo`, `owner/repo` (GitHub)
 *
 * Returns null if unparseable.
 */
export function parseRepoInput(input: string, defaultInterval: number = 5): RepoConfig | null {
    const trimmed = input.trim();
    if (!trimmed) { return null; }

    const build = (forge: ForgePlatform, path: string, host?: string): RepoConfig | null => {
        // URLs copied from an issue, MR or file page: GitLab puts these after "/-/",
        // GitHub after the repo name.
        let parts = path.replace(/[?#].*$/, '').replace(/\/-(\/.*)?$/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
        if (forge === 'github' && parts.length > 2 && GITHUB_SUBPAGES.has(parts[2])) {
            parts = parts.slice(0, 2);
        }
        if (parts.length < 2) { return null; }
        // GitLab allows nested groups; the last segment is the project.
        if (forge === 'github' && parts.length !== 2) { return null; }
        const repo = parts[parts.length - 1];
        const owner = parts.slice(0, -1).join('/');
        if (!/^[\w.-]+$/.test(repo) || !/^[\w.-]+(\/[\w.-]+)*$/.test(owner)) { return null; }
        const cfg: RepoConfig = { forge, owner, repo, pollIntervalMinutes: defaultInterval };
        if (host && host !== 'github.com' && host !== 'gitlab.com') { cfg.host = host; }
        return cfg;
    };

    const forgeForHost = (host: string): ForgePlatform => (host.includes('gitlab') ? 'gitlab' : 'github');

    const https = trimmed.match(/^https?:\/\/([^/]+)\/(.+?)\/?$/i);
    if (https) {
        const host = normalizeHost(https[1]);
        return build(forgeForHost(host), https[2], host);
    }

    const ssh = trimmed.match(/^git@([^:]+):(.+)$/i);
    if (ssh) {
        const host = normalizeHost(ssh[1]);
        return build(forgeForHost(host), ssh[2], host);
    }

    const prefixed = trimmed.match(/^(github|gitlab):(.+)$/i);
    if (prefixed) {
        return build(prefixed[1].toLowerCase() as ForgePlatform, prefixed[2]);
    }

    if (/^[^/:\s]+\/[^/:\s]+$/.test(trimmed)) {
        return build('github', trimmed);
    }

    return null;
}

/** Canonical display string, e.g. `github:owner/repo` or `gitlab:git.example.com/group/repo`. */
export function formatRepoString(config: RepoConfig): string {
    return config.host
        ? `${config.forge}:${config.host}/${config.owner}/${config.repo}`
        : `${config.forge}:${config.owner}/${config.repo}`;
}

function sameRepo(a: RepoConfig, b: RepoConfig): boolean {
    return repoKey(a) === repoKey(b) && (a.host ?? '') === (b.host ?? '');
}

/**
 * Add a repo to the persisted settings. Returns true if added (not duplicate).
 * Self-hosted repos are stored in object form so the host survives a round trip.
 */
export async function addRepoToSettings(repoInput: string): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration('argus');
    const entries = [...(cfg.get<unknown[]>('repos', []) ?? [])];

    const parsed = parseRepoInput(repoInput);
    if (!parsed) { return false; }

    const isDuplicate = entries.some((e) => {
        const existing = parseRepoEntry(e);
        return existing !== null && sameRepo(existing, parsed);
    });
    if (isDuplicate) { return false; }

    entries.push(
        parsed.host
            ? { repo: `${parsed.forge}:${parsed.owner}/${parsed.repo}`, host: parsed.host }
            : `${parsed.forge}:${parsed.owner}/${parsed.repo}`,
    );
    await cfg.update('repos', entries, vscode.ConfigurationTarget.Global);
    return true;
}

/** Remove a repo from persisted settings. Returns true if removed. */
export async function removeRepoFromSettings(target: RepoConfig): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration('argus');
    const entries = [...(cfg.get<unknown[]>('repos', []) ?? [])];
    const filtered = entries.filter((e) => {
        const existing = parseRepoEntry(e);
        return !existing || !sameRepo(existing, target);
    });
    if (filtered.length === entries.length) { return false; }
    await cfg.update('repos', filtered, vscode.ConfigurationTarget.Global);
    return true;
}

function buildRepoEmailOverrides(repos: RepoConfig[]): Map<RepoKey, RepoEmailOverride> {
    const map = new Map<RepoKey, RepoEmailOverride>();
    for (const repo of repos) {
        if (repo.email && (repo.email.recipients?.length || repo.email.smtp)) {
            map.set(repoKey(repo), {
                recipients: repo.email.recipients ?? [],
                smtp: repo.email.smtp ? { ...repo.email.smtp } : undefined,
            });
        }
    }
    return map;
}
