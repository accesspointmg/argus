// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Config — reads Argus settings from VS Code workspace configuration.
 */

import * as vscode from 'vscode';
import type { RepoConfig, RepoEmailConfig, ForgePlatform, RepoKey } from '../forge/types';
import { repoKey } from '../forge/types';
import type { LogLevel } from './logger';
import type { EmailConfig, RepoEmailOverride } from '../notifications/email';
import type { PipelineConfig } from '../agent/pipeline';

export interface ArgusConfig {
    repos: RepoConfig[];
    defaultPollIntervalMinutes: number;
    maxConcurrentIssues: number;
    maxCodingIterations: number;
    branchPrefix: string;
    dryRun: boolean;
    logLevel: LogLevel;
    email: EmailConfig;
}

export function readConfig(): ArgusConfig {
    const cfg = vscode.workspace.getConfiguration('argus');

    // Parse repos from settings — each entry can be a string or an object with email overrides
    const repoEntries: (string | Record<string, any>)[] = cfg.get('repos', []);
    const defaultInterval: number = cfg.get('pollIntervalMinutes', 5);

    const repos: RepoConfig[] = repoEntries
        .map((r) => parseRepoEntry(r, defaultInterval))
        .filter((r): r is RepoConfig => r !== null);

    // Email config — SMTP password is injected later from SecretStorage
    const smtpObj: Record<string, any> = cfg.get('email.smtp', {});
    const emailCfg: EmailConfig = {
        enabled: cfg.get('email.enabled', false),
        smtp: {
            host: smtpObj.host ?? '',
            port: smtpObj.port ?? 587,
            secure: smtpObj.secure ?? false,
            user: smtpObj.user ?? '',
            pass: '',  // Injected from SecretStorage in extension.ts
        },
        fromAddress: cfg.get('email.fromAddress', ''),
        fromName: cfg.get('email.fromName', 'Argus'),
        defaultRecipients: cfg.get('email.defaultRecipients', []),
        repoOverrides: buildRepoEmailOverrides(repos),
    };

    return {
        repos,
        defaultPollIntervalMinutes: defaultInterval,
        maxConcurrentIssues: cfg.get('maxConcurrentIssues', 3),
        maxCodingIterations: cfg.get('maxCodingIterations', 5),
        branchPrefix: cfg.get('branchPrefix', 'argus/'),
        dryRun: cfg.get('dryRun', false),
        logLevel: cfg.get('logLevel', 'info') as LogLevel,
        email: emailCfg,
    };
}

/**
 * Parse a repo entry from settings. Accepts:
 *   - A plain string (any format parseRepoInput accepts)
 *   - An object: { repo: "owner/repo", email: { recipients: [...], smtp: {...} } }
 */
export function parseRepoEntry(input: string | Record<string, any>, defaultInterval: number = 5): RepoConfig | null {
    if (typeof input === 'string') {
        return parseRepoInput(input, defaultInterval);
    }

    // Object form: { repo: "...", email?: { recipients?: [...], smtp?: {...} } }
    const repoStr = input.repo || input.url || '';
    const parsed = parseRepoInput(String(repoStr), defaultInterval);
    if (!parsed) { return null; }

    if (input.email && typeof input.email === 'object') {
        const email: RepoEmailConfig = {};
        if (Array.isArray(input.email.recipients)) {
            email.recipients = input.email.recipients;
        }
        if (input.email.smtp && typeof input.email.smtp === 'object') {
            email.smtp = input.email.smtp;
        }
        parsed.email = email;
    }

    return parsed;
}

/**
 * Parse any repo input format:
 *   - "https://github.com/owner/repo.git"
 *   - "https://github.com/owner/repo"
 *   - "git@github.com:owner/repo.git"
 *   - "https://gitlab.com/owner/repo"
 *   - "github:owner/repo"
 *   - "gitlab:owner/repo"
 *   - "owner/repo"  (defaults to github)
 *
 * Returns null if unparseable.
 */
export function parseRepoInput(input: string, defaultInterval: number = 5): RepoConfig | null {
    const trimmed = input.trim();
    if (!trimmed) { return null; }

    // Try HTTPS URL: https://github.com/owner/repo(.git)
    const httpsMatch = trimmed.match(
        /^https?:\/\/(github\.com|gitlab\.com|gitlab\.[^/]+)\/([^/]+)\/([^/.]+?)(?:\.git)?$/i
    );
    if (httpsMatch) {
        const host = httpsMatch[1].toLowerCase();
        const forge: ForgePlatform = host.startsWith('gitlab') ? 'gitlab' : 'github';
        return { forge, owner: httpsMatch[2], repo: httpsMatch[3], pollIntervalMinutes: defaultInterval };
    }

    // Try SSH URL: git@github.com:owner/repo.git
    const sshMatch = trimmed.match(
        /^git@(github\.com|gitlab\.com|gitlab\.[^:]+):([^/]+)\/([^/.]+?)(?:\.git)?$/i
    );
    if (sshMatch) {
        const host = sshMatch[1].toLowerCase();
        const forge: ForgePlatform = host.startsWith('gitlab') ? 'gitlab' : 'github';
        return { forge, owner: sshMatch[2], repo: sshMatch[3], pollIntervalMinutes: defaultInterval };
    }

    // Try "platform:owner/repo"
    const prefixMatch = trimmed.match(/^(github|gitlab):([^/]+)\/(.+)$/i);
    if (prefixMatch) {
        return {
            forge: prefixMatch[1].toLowerCase() as ForgePlatform,
            owner: prefixMatch[2],
            repo: prefixMatch[3],
            pollIntervalMinutes: defaultInterval,
        };
    }

    // Try bare "owner/repo" (defaults to github)
    const bareMatch = trimmed.match(/^([^/]+)\/([^/]+)$/);
    if (bareMatch) {
        return { forge: 'github', owner: bareMatch[1], repo: bareMatch[2], pollIntervalMinutes: defaultInterval };
    }

    return null;
}

/**
 * Format a RepoConfig back to a canonical display string.
 */
export function formatRepoString(config: RepoConfig): string {
    return `${config.forge}:${config.owner}/${config.repo}`;
}

/**
 * Add a repo string to the persisted settings. Returns true if added (not duplicate).
 */
export async function addRepoToSettings(repoString: string): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration('argus');
    const repos: string[] = [...cfg.get<string[]>('repos', [])];

    // Parse to validate
    const parsed = parseRepoInput(repoString);
    if (!parsed) { return false; }

    // Canonical form for dedup
    const canonical = formatRepoString(parsed);

    // Check for duplicates
    const isDuplicate = repos.some((r) => {
        const existing = parseRepoInput(r);
        return existing && formatRepoString(existing) === canonical;
    });
    if (isDuplicate) { return false; }

    repos.push(canonical);
    await cfg.update('repos', repos, vscode.ConfigurationTarget.Global);
    return true;
}

/**
 * Remove a repo string from persisted settings. Returns true if removed.
 */
export async function removeRepoFromSettings(repoString: string): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration('argus');
    const repos: string[] = [...cfg.get<string[]>('repos', [])];

    const target = parseRepoInput(repoString);
    if (!target) { return false; }
    const targetCanonical = formatRepoString(target);

    const filtered = repos.filter((r) => {
        const existing = parseRepoInput(r);
        return !existing || formatRepoString(existing) !== targetCanonical;
    });

    if (filtered.length === repos.length) { return false; }

    await cfg.update('repos', filtered, vscode.ConfigurationTarget.Global);
    return true;
}

/**
 * Build per-repo email overrides from parsed RepoConfigs.
 */
function buildRepoEmailOverrides(repos: RepoConfig[]): Map<RepoKey, RepoEmailOverride> {
    const map = new Map<RepoKey, RepoEmailOverride>();
    for (const repo of repos) {
        if (repo.email && (repo.email.recipients?.length || repo.email.smtp)) {
            const key = repoKey(repo);
            map.set(key, {
                recipients: repo.email.recipients ?? [],
                smtp: repo.email.smtp ? {
                    host: repo.email.smtp.host,
                    port: repo.email.smtp.port,
                    secure: repo.email.smtp.secure,
                    user: repo.email.smtp.user,
                } : undefined,
            });
        }
    }
    return map;
}

/**
 * Extract PipelineConfig from ArgusConfig.
 */
export function toPipelineConfig(config: ArgusConfig): Partial<PipelineConfig> {
    return {
        maxConcurrentIssues: config.maxConcurrentIssues,
        maxCodingIterations: config.maxCodingIterations,
        branchPrefix: config.branchPrefix,
        dryRun: config.dryRun,
    };
}
