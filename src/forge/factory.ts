// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Forge factory — creates the appropriate forge implementation based on config.
 */

import * as vscode from 'vscode';
import type { Forge, RepoConfig, ForgePlatform } from './types';
import { GitHubForge } from './github';
import { GitLabForge } from './gitlab';
import { baseUrlForHost } from './util';

export const GITHUB_TOKEN_KEY = 'argus.githubToken';
export const GITLAB_TOKEN_KEY = 'argus.gitlabToken';

/**
 * Secret-storage key for a platform, scoped by host for self-hosted instances so a
 * github.com/gitlab.com token is never sent to another server.
 */
export function tokenKeyForPlatform(platform: ForgePlatform, host?: string): string {
    const base = platform === 'gitlab' ? GITLAB_TOKEN_KEY : GITHUB_TOKEN_KEY;
    const h = normalizeHostKey(platform, host);
    return h ? `${base}:${h}` : base;
}

/** Lower-cased host without scheme/trailing slash; undefined for the public SaaS host. */
function normalizeHostKey(platform: ForgePlatform, host?: string): string | undefined {
    const h = host?.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    if (!h) { return undefined; }
    const saas = platform === 'gitlab' ? ['gitlab.com'] : ['github.com', 'api.github.com'];
    return saas.includes(h) ? undefined : h;
}

/**
 * Check whether a token exists for the given platform (and self-hosted host).
 */
export async function hasToken(platform: ForgePlatform, secrets: vscode.SecretStorage, host?: string): Promise<boolean> {
    const val = await secrets.get(tokenKeyForPlatform(platform, host));
    return !!val;
}

/**
 * Prompt the user for a token and store it. Returns the token, or undefined if dismissed.
 */
export async function promptAndStoreToken(
    platform: ForgePlatform,
    secrets: vscode.SecretStorage,
    host?: string,
): Promise<string | undefined> {
    const hostKey = normalizeHostKey(platform, host);
    const label = (platform === 'gitlab' ? 'GitLab' : 'GitHub') + (hostKey ? ` (${hostKey})` : '');
    const placeholder = platform === 'gitlab' ? 'glpat-...' : 'github_pat_...';
    const prompt = platform === 'gitlab'
        ? `Enter a ${label} access token for Argus (scope: api). Prefer a project access token with Developer role.`
        : `Enter a ${label} fine-grained token for Argus, limited to monitored repos (Contents, Issues, Pull requests, Commit statuses: read & write).`;

    const entered = await vscode.window.showInputBox({
        title: `Set ${label} Token`,
        prompt,
        password: true,
        placeHolder: placeholder,
        validateInput: (v) => v.trim() ? undefined : 'Token cannot be empty',
    });
    if (!entered) { return undefined; }

    await secrets.store(tokenKeyForPlatform(platform, host), entered.trim());
    return entered.trim();
}

/**
 * Delete a stored token for the given platform.
 */
export async function clearToken(platform: ForgePlatform, secrets: vscode.SecretStorage, host?: string): Promise<void> {
    await secrets.delete(tokenKeyForPlatform(platform, host));
}

/**
 * Create a Forge instance for the given repo configuration.
 * Retrieves tokens from VS Code SecretStorage; prompts if missing.
 */
export async function createForge(
    config: RepoConfig,
    secrets: vscode.SecretStorage,
): Promise<Forge> {
    // Validate the host before any token is read for it.
    const baseUrl = baseUrlForHost(config.forge, config.host);
    const key = tokenKeyForPlatform(config.forge, config.host);
    let token = await secrets.get(key);

    if (!token) {
        token = await promptAndStoreToken(config.forge, secrets, config.host);
        if (!token) {
            const label = config.forge === 'gitlab' ? 'GitLab' : 'GitHub';
            throw new Error(`${label} token is required. Run "Argus: Set ${label} Token" first.`);
        }
    }

    // `host` selects GitHub Enterprise / self-hosted GitLab; https only.
    switch (config.forge) {
        case 'github':
            return new GitHubForge(config.owner, config.repo, token, baseUrl);
        case 'gitlab':
            return new GitLabForge(config.owner, config.repo, token, baseUrl);
        default:
            throw new Error(`Unsupported forge platform: ${config.forge}`);
    }
}
