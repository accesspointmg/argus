// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Forge factory — creates the appropriate forge implementation based on config.
 */

import * as vscode from 'vscode';
import type { Forge, RepoConfig, ForgePlatform } from './types';
import { GitHubForge } from './github';
import { GitLabForge } from './gitlab';

export const GITHUB_TOKEN_KEY = 'argus.githubToken';
export const GITLAB_TOKEN_KEY = 'argus.gitlabToken';

/**
 * Return the secret-storage key for a given platform.
 */
export function tokenKeyForPlatform(platform: ForgePlatform): string {
    return platform === 'gitlab' ? GITLAB_TOKEN_KEY : GITHUB_TOKEN_KEY;
}

/**
 * Check whether a token exists for the given platform.
 */
export async function hasToken(platform: ForgePlatform, secrets: vscode.SecretStorage): Promise<boolean> {
    const val = await secrets.get(tokenKeyForPlatform(platform));
    return !!val;
}

/**
 * Prompt the user for a token and store it. Returns the token, or undefined if dismissed.
 */
export async function promptAndStoreToken(
    platform: ForgePlatform,
    secrets: vscode.SecretStorage,
): Promise<string | undefined> {
    const label = platform === 'gitlab' ? 'GitLab' : 'GitHub';
    const placeholder = platform === 'gitlab' ? 'glpat-...' : 'ghp_...';

    const entered = await vscode.window.showInputBox({
        title: `Set ${label} Token`,
        prompt: `Enter your ${label} Personal Access Token for Argus (scopes: repo, read:user)`,
        password: true,
        placeHolder: placeholder,
        validateInput: (v) => v.trim() ? undefined : 'Token cannot be empty',
    });
    if (!entered) { return undefined; }

    await secrets.store(tokenKeyForPlatform(platform), entered.trim());
    return entered.trim();
}

/**
 * Delete a stored token for the given platform.
 */
export async function clearToken(platform: ForgePlatform, secrets: vscode.SecretStorage): Promise<void> {
    await secrets.delete(tokenKeyForPlatform(platform));
}

/**
 * Create a Forge instance for the given repo configuration.
 * Retrieves tokens from VS Code SecretStorage; prompts if missing.
 */
export async function createForge(
    config: RepoConfig,
    secrets: vscode.SecretStorage,
): Promise<Forge> {
    const key = tokenKeyForPlatform(config.forge);
    let token = await secrets.get(key);

    if (!token) {
        token = await promptAndStoreToken(config.forge, secrets);
        if (!token) {
            const label = config.forge === 'gitlab' ? 'GitLab' : 'GitHub';
            throw new Error(`${label} token is required. Run "Argus: Set ${label} Token" first.`);
        }
    }

    switch (config.forge) {
        case 'github':
            return new GitHubForge(config.owner, config.repo, token);
        case 'gitlab':
            return new GitLabForge(config.owner, config.repo, token);
        default:
            throw new Error(`Unsupported forge platform: ${config.forge}`);
    }
}
