// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Config — reads Argus settings from VS Code workspace configuration.
 */

import * as vscode from 'vscode';
import type { RepoConfig, ForgePlatform } from '../forge/types';
import type { LogLevel } from './logger';
import type { EmailConfig } from '../notifications/email';
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

    // Parse repos from settings — each entry can be a URL, "github:owner/repo", or "owner/repo"
    const repoStrings: string[] = cfg.get('repos', []);
    const defaultInterval: number = cfg.get('pollIntervalMinutes', 5);

    const repos: RepoConfig[] = repoStrings
        .map((r) => parseRepoInput(r, defaultInterval))
        .filter((r): r is RepoConfig => r !== null);

    // Email config
    const emailCfg: EmailConfig = {
        enabled: cfg.get('email.enabled', false),
        smtpHost: cfg.get('email.smtpHost', ''),
        smtpPort: cfg.get('email.smtpPort', 587),
        smtpSecure: cfg.get('email.smtpSecure', false),
        smtpUser: cfg.get('email.smtpUser', ''),
        smtpPass: '',  // Will be read from SecretStorage
        fromAddress: cfg.get('email.fromAddress', ''),
        fromName: cfg.get('email.fromName', 'Argus'),
        toAddresses: cfg.get('email.toAddresses', []),
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
