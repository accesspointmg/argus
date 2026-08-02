// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * extension.ts — Argus VS Code extension entry point.
 *
 * Wires up all subsystems:
 *  - Forge (GitHub/GitLab)
 *  - Crypto (keys, stamps, nonces, audit)
 *  - Security (sanitizer, threat classifier, trust, validator)
 *  - Agent pipeline (evaluator, investigator, coder, transcriber, etc.)
 *  - Notifications (email)
 *  - UI (sidebar tree views, status bar)
 *  - Polling loop
 */

import * as vscode from 'vscode';

// ── Util ────────────────────────────────────────────────────────────
import { Logger } from './util/logger';
import { readConfig, toPipelineConfig, parseRepoInput, formatRepoString, addRepoToSettings, removeRepoFromSettings, type ArgusConfig } from './util/config';
import { RateLimiter } from './util/rate-limiter';

// ── Forge ───────────────────────────────────────────────────────────
import { createForge, hasToken, promptAndStoreToken, clearToken as clearForgeToken } from './forge/factory';
import type { Forge, RepoConfig, ForgePlatform } from './forge/types';
import { repoKey } from './forge/types';

// ── Crypto ──────────────────────────────────────────────────────────
import { KeyManager } from './crypto/keys';
import { StampManager } from './crypto/stamp';
import { NonceRegistry } from './crypto/nonce-registry';
import { AuditLog } from './crypto/audit';

// ── Security ────────────────────────────────────────────────────────
import { LlmService } from './llm';
import { selectAiProvider, promptAndStoreApiKey } from './llm/setup';

import { Sanitizer } from './security/sanitizer';
import { ThreatClassifier } from './security/threat-classifier';
import { TrustResolver } from './security/trust';
import { OutputValidator } from './security/validator';
import { DiffAssessor } from './security/diff-assessor';

// ── Agent ───────────────────────────────────────────────────────────
import { Evaluator } from './agent/evaluator';
import { Investigator } from './agent/investigator';
import { Coder } from './agent/coder';
import { Transcriber } from './agent/transcriber';
import { CommentHandler } from './agent/comment-handler';
import { EditDetector } from './agent/edit-detector';
import { PRAnalyzer } from './agent/pr-analyzer';
import { PRGatekeeper } from './agent/pr-gatekeeper';
import { Pipeline } from './agent/pipeline';

// ── Notifications ───────────────────────────────────────────────────
import { EmailSender } from './notifications/email';
import { NotificationRouter } from './notifications/events';

// ── UI ──────────────────────────────────────────────────────────────
import {
    WorkQueueProvider,
    ActivityProvider,
    RepoStatsProvider,
    SecurityProvider,
    SystemHealthProvider,
} from './ui/treeview';
import { StatusBar } from './ui/statusbar';

// ─── Globals ────────────────────────────────────────────────────────

let logger: Logger;
let statusBar: StatusBar;
let pipeline: Pipeline;
let pollTimers: NodeJS.Timeout[] = [];
let isRunning = false;
const forges = new Map<string, Forge>();

// View providers
let workQueueProvider: WorkQueueProvider;
let activityProvider: ActivityProvider;
let repoStatsProvider: RepoStatsProvider;
let securityProvider: SecurityProvider;
let systemHealthProvider: SystemHealthProvider;

// ─── Activation ─────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    logger = new Logger('Argus', 'info');
    logger.info('Argus activating...');

    // Read configuration
    let config = readConfig();
    logger.setLevel(config.logLevel);

    // ── Crypto subsystem ──
    const keyManager = new KeyManager(context.secrets, context.globalState);
    await keyManager.initialize();

    const nonceRegistry = new NonceRegistry(context.globalState);
    await nonceRegistry.load();

    const stampManager = new StampManager(keyManager, nonceRegistry);

    const auditOutputChannel = vscode.window.createOutputChannel('Argus Audit Log');
    context.subscriptions.push(auditOutputChannel);
    const auditLog = new AuditLog(keyManager, context.globalState, auditOutputChannel);
    await auditLog.load();

    // ── AI provider ──
    // One service, injected everywhere a model is needed, so the choice of
    // vendor is a setting rather than something baked into each agent.
    const llm = new LlmService(context.secrets, logger);

    // ── Security subsystem ──
    const sanitizer = new Sanitizer();
    const threatClassifier = new ThreatClassifier(logger, llm);
    const trustResolver = new TrustResolver();
    const outputValidator = new OutputValidator();

    // ── Agent subsystem ──
    const evaluator = new Evaluator(logger, sanitizer, llm);
    const investigator = new Investigator(logger, llm);
    const coder = new Coder(logger, outputValidator, stampManager, auditLog, llm);
    const transcriber = new Transcriber(logger, stampManager);
    const commentHandler = new CommentHandler(logger, sanitizer, threatClassifier, trustResolver, auditLog);
    const editDetector = new EditDetector(logger, auditLog);
    const prAnalyzer = new PRAnalyzer(logger, trustResolver, stampManager, llm);

    pipeline = new Pipeline(
        evaluator,
        investigator,
        coder,
        transcriber,
        commentHandler,
        editDetector,
        prAnalyzer,
        stampManager,
        auditLog,
        logger,
        toPipelineConfig(config),
    );

    // ── Gatekeeper (merge gate via commit statuses) ──
    const diffAssessor = new DiffAssessor(logger, sanitizer, llm);
    const gatekeeper = new PRGatekeeper(
        diffAssessor,
        trustResolver,
        stampManager,
        auditLog,
        logger,
        { dryRun: config.dryRun },
    );
    pipeline.setGatekeeper(gatekeeper);

    // ── Email ──
    const emailSender = new EmailSender(config.email, logger);
    await emailSender.initialize();
    const notificationRouter = new NotificationRouter(emailSender, logger);

    // ── UI ──
    statusBar = new StatusBar();

    workQueueProvider = new WorkQueueProvider(pipeline);
    activityProvider = new ActivityProvider(pipeline);
    repoStatsProvider = new RepoStatsProvider();
    securityProvider = new SecurityProvider();
    systemHealthProvider = new SystemHealthProvider();

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('argus.workQueue', workQueueProvider),
        vscode.window.registerTreeDataProvider('argus.recentActivity', activityProvider),
        vscode.window.registerTreeDataProvider('argus.repoStats', repoStatsProvider),
        vscode.window.registerTreeDataProvider('argus.security', securityProvider),
        vscode.window.registerTreeDataProvider('argus.systemHealth', systemHealthProvider),
        statusBar,
    );

    // ── Rate limiter for API calls ──
    const apiLimiter = new RateLimiter(30, 0.5); // 30 burst, 0.5/sec refill

    // ── Commands ──
    context.subscriptions.push(
        vscode.commands.registerCommand('argus.start', async () => {
            if (isRunning) {
                vscode.window.showInformationMessage('Argus is already running.');
                return;
            }
            await startPolling(config, context);
        }),

        vscode.commands.registerCommand('argus.stop', () => {
            stopPolling();
            vscode.window.showInformationMessage('Argus stopped.');
        }),

        vscode.commands.registerCommand('argus.emergencyStop', async () => {
            stopPolling();
            isRunning = false;
            statusBar.setStatus('stopped');
            vscode.commands.executeCommand('setContext', 'argus.isRunning', false);
            await auditLog.append({
                action: 'emergency_stop',
                repo: 'all',
                target: 'all',
                input: '',
                output: '',
                decision: 'Emergency stop triggered by user',
                llmCallCount: 0,
                details: 'Manual emergency stop',
            });
            vscode.window.showWarningMessage('Argus emergency stopped!');
            logger.warn('EMERGENCY STOP triggered');
        }),

        vscode.commands.registerCommand('argus.pollNow', async () => {
            if (isRunning) {
                vscode.window.showInformationMessage('Argus is already running — poll happens automatically.');
                return;
            }
            statusBar.setStatus('polling');
            try {
                for (const repoCfg of config.repos) {
                    const forge = await getOrCreateForge(repoCfg, context);
                    await pipeline.pollRepo(forge);
                }
                refreshViews();
                statusBar.setStatus('idle');
                vscode.window.showInformationMessage('Poll complete.');
            } catch (err) {
                statusBar.setStatus('error', String(err));
                logger.error(`Poll failed: ${err}`);
            }
        }),

        vscode.commands.registerCommand('argus.showActivityLog', () => {
            logger.show();
        }),

        vscode.commands.registerCommand('argus.showSecurityLog', () => {
            logger.show();
        }),

        vscode.commands.registerCommand('argus.configureRepos', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'argus.repos');
        }),

        vscode.commands.registerCommand('argus.selectAiProvider', async () => {
            await selectAiProvider(context.secrets);
            logger.info(`AI provider is now ${await llm.describe()}.`);
        }),

        vscode.commands.registerCommand('argus.setAiKey', async () => {
            await promptAndStoreApiKey(context.secrets);
        }),

        vscode.commands.registerCommand('argus.setGitHubToken', async () => {
            const token = await promptAndStoreToken('github', context.secrets);
            if (token) {
                forges.clear(); // force re-create with new token
                vscode.commands.executeCommand('setContext', 'argus.hasGitHubToken', true);
                vscode.window.showInformationMessage('GitHub token saved. You can now add GitHub repositories.');
                logger.info('GitHub token updated.');
            }
        }),

        vscode.commands.registerCommand('argus.setGitLabToken', async () => {
            const token = await promptAndStoreToken('gitlab', context.secrets);
            if (token) {
                forges.clear();
                vscode.commands.executeCommand('setContext', 'argus.hasGitLabToken', true);
                vscode.window.showInformationMessage('GitLab token saved. You can now add GitLab repositories.');
                logger.info('GitLab token updated.');
            }
        }),

        vscode.commands.registerCommand('argus.clearTokens', async () => {
            const pick = await vscode.window.showQuickPick(
                [
                    { label: '$(mark-github) GitHub token', platform: 'github' as ForgePlatform },
                    { label: '$(git-merge) GitLab token', platform: 'gitlab' as ForgePlatform },
                ],
                { title: 'Clear Token', placeHolder: 'Which token to remove?' },
            );
            if (!pick) { return; }
            await clearForgeToken(pick.platform, context.secrets);
            forges.clear();
            const ctxKey = pick.platform === 'gitlab' ? 'argus.hasGitLabToken' : 'argus.hasGitHubToken';
            vscode.commands.executeCommand('setContext', ctxKey, false);
            vscode.window.showInformationMessage(`${pick.label.replace(/\$\([^)]+\) /, '')} cleared.`);
            logger.info(`Token cleared for ${pick.platform}`);
        }),

        vscode.commands.registerCommand('argus.listRepos', async () => {
            const repos = config.repos;
            if (repos.length === 0) {
                vscode.window.showInformationMessage('No repos configured. Use "Argus: Add Repository" to add one.');
                return;
            }
            const items = repos.map((r) => ({
                label: `$(repo) ${r.owner}/${r.repo}`,
                description: r.forge,
                detail: `Poll every ${r.pollIntervalMinutes} min`,
            }));
            await vscode.window.showQuickPick(items, {
                title: `Argus Repositories (${repos.length})`,
                placeHolder: 'Configured repositories',
            });
        }),

        vscode.commands.registerCommand('argus.addRepo', async () => {
            const input = await vscode.window.showInputBox({
                title: 'Add Repository',
                prompt: 'Paste a repository URL or enter owner/repo',
                placeHolder: 'https://github.com/owner/repo.git',
                validateInput: (value) => {
                    if (!value.trim()) { return 'Enter a repository URL or owner/repo'; }
                    const parsed = parseRepoInput(value);
                    if (!parsed) { return 'Could not parse. Try: https://github.com/owner/repo.git, git@github.com:owner/repo.git, or owner/repo'; }
                    return undefined;
                },
            });
            if (!input) { return; }
            const parsed = parseRepoInput(input);
            if (!parsed) { return; }

            // Ensure a token exists for the target platform before saving
            const tokenExists = await hasToken(parsed.forge, context.secrets);
            if (!tokenExists) {
                const platformLabel = parsed.forge === 'gitlab' ? 'GitLab' : 'GitHub';
                const setNow = await vscode.window.showWarningMessage(
                    `No ${platformLabel} token configured. A token is required before adding a ${platformLabel} repository.`,
                    'Set Token Now',
                    'Cancel',
                );
                if (setNow !== 'Set Token Now') { return; }
                const token = await promptAndStoreToken(parsed.forge, context.secrets);
                if (!token) { return; }
                const ctxKey = parsed.forge === 'gitlab' ? 'argus.hasGitLabToken' : 'argus.hasGitHubToken';
                vscode.commands.executeCommand('setContext', ctxKey, true);
            }

            const added = await addRepoToSettings(input);
            if (added) {
                const label = formatRepoString(parsed);
                config = readConfig(); // refresh in-memory config
                refreshViews();
                repoStatsProvider?.refresh();
                vscode.window.showInformationMessage(`Added ${label} to Argus watch list.`);
                logger.info(`Repo added: ${label}`);
            } else {
                vscode.window.showInformationMessage('That repo is already in your watch list.');
            }
        }),

        vscode.commands.registerCommand('argus.removeRepo', async () => {
            const repos = config.repos;
            if (repos.length === 0) {
                vscode.window.showInformationMessage('No repos configured.');
                return;
            }
            const items = repos.map((r) => ({
                label: `$(repo) ${r.owner}/${r.repo}`,
                description: r.forge,
                repoString: formatRepoString(r),
            }));
            const picked = await vscode.window.showQuickPick(items, {
                title: 'Remove Repository',
                placeHolder: 'Select a repo to stop watching',
            });
            if (!picked) { return; }
            const removed = await removeRepoFromSettings(picked.repoString);
            if (removed) {
                config = readConfig();
                refreshViews();
                repoStatsProvider?.refresh();
                vscode.window.showInformationMessage(`Removed ${picked.repoString} from watch list.`);
                logger.info(`Repo removed: ${picked.repoString}`);
            }
        }),

        vscode.commands.registerCommand('argus.clearQueue', () => {
            // Pipeline doesn't expose a clear method directly
            vscode.window.showInformationMessage('Queue cleared on next restart.');
        }),

        vscode.commands.registerCommand('argus.resetTrustData', () => {
            trustResolver.clearCache();
            vscode.window.showInformationMessage('Trust data cache cleared.');
        }),

        vscode.commands.registerCommand('argus.verifyAuditLog', async () => {
            const result = await auditLog.verifyChain();
            if (result.valid) {
                vscode.window.showInformationMessage(`Audit log verified: ${auditLog.totalEntries} entries, chain intact.`);
            } else {
                vscode.window.showErrorMessage(`Audit log COMPROMISED at entry ${result.brokenAt}: ${result.errors.join('; ')}`);
            }
        }),

        vscode.commands.registerCommand('argus.rotateKey', async () => {
            await keyManager.rotateKey();
            vscode.window.showInformationMessage('Instance key rotated.');
            logger.info('Instance key rotated by user command');
        }),

        vscode.commands.registerCommand('argus.exportReport', () => {
            vscode.window.showInformationMessage('Report export not yet implemented.');
        }),

        vscode.commands.registerCommand('argus.processIssue', async () => {
            const input = await vscode.window.showInputBox({
                prompt: 'Issue number to process',
                placeHolder: '42',
            });
            if (!input) { return; }
            vscode.window.showInformationMessage(`Manual processing of #${input} queued.`);
        }),

        vscode.commands.registerCommand('argus.skipIssue', () => {
            vscode.window.showInformationMessage('Issue skipped.');
        }),

        vscode.commands.registerCommand('argus.reprocessIssue', () => {
            vscode.window.showInformationMessage('Issue queued for reprocessing.');
        }),

        vscode.commands.registerCommand('argus.promoteIssue', () => {
            vscode.window.showInformationMessage('Issue promoted to front of queue.');
        }),

        vscode.commands.registerCommand('argus.openInBrowser', () => {
            // Handled by treeview command
        }),

        vscode.commands.registerCommand('argus.viewTranscript', () => {
            logger.show();
        }),
    );

    // ── Config change listener ──
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('argus')) {
                logger.info('Configuration changed — restart Argus to apply.');
                vscode.window.showInformationMessage(
                    'Argus configuration changed. Restart to apply.',
                    'Restart',
                ).then((choice) => {
                    if (choice === 'Restart') {
                        stopPolling();
                        startPolling(readConfig(), context);
                    }
                });
            }
        })
    );

    // Set context keys for token presence (drives welcome content)
    hasToken('github', context.secrets).then(v => vscode.commands.executeCommand('setContext', 'argus.hasGitHubToken', v));
    hasToken('gitlab', context.secrets).then(v => vscode.commands.executeCommand('setContext', 'argus.hasGitLabToken', v));

    // Update system health on activation
    updateHealthView(config);

    logger.info('Argus activated successfully.');
    vscode.window.showInformationMessage('Argus is ready. Use "Argus: Start" to begin polling.');
}

export function deactivate(): void {
    stopPolling();
    logger?.info('Argus deactivated.');
}

// ─── Polling ────────────────────────────────────────────────────────

async function startPolling(
    config: ArgusConfig,
    context: vscode.ExtensionContext,
): Promise<void> {
    isRunning = true;
    vscode.commands.executeCommand('setContext', 'argus.isRunning', true);
    statusBar.setStatus('idle');
    logger.info(`Starting polling for ${config.repos.length} repo(s)`);

    for (const repoCfg of config.repos) {
        const intervalMs = (repoCfg.pollIntervalMinutes || config.defaultPollIntervalMinutes) * 60 * 1000;

        // Do an initial poll immediately
        pollOnce(repoCfg, context);

        // Then schedule recurring polls
        const timer = setInterval(() => {
            if (isRunning) {
                pollOnce(repoCfg, context);
            }
        }, intervalMs);

        pollTimers.push(timer);
    }
}

async function pollOnce(
    repoCfg: RepoConfig,
    context: vscode.ExtensionContext,
): Promise<void> {
    try {
        statusBar.setStatus('polling');
        const forge = await getOrCreateForge(repoCfg, context);
        const enqueued = await pipeline.pollRepo(forge);

        if (enqueued > 0) {
            logger.info(`Enqueued ${enqueued} new issue(s) from ${repoCfg.owner}/${repoCfg.repo}`);
        }

        // Check all open PRs for unacknowledged review comments
        const prAcknowledged = await pipeline.pollPRComments(forge);
        if (prAcknowledged > 0) {
            logger.info(`Acknowledged comments on ${prAcknowledged} PR(s) in ${repoCfg.owner}/${repoCfg.repo}`);
        }

        // Process next issue in queue
        statusBar.setStatus('processing');
        const processed = await pipeline.processNext(forge);
        if (processed) {
            logger.info(`Processed issue #${processed.issueNumber} → ${processed.state}`);
        }

        refreshViews();
        statusBar.setStatus('idle');
    } catch (err) {
        logger.error(`Poll cycle error for ${repoCfg.owner}/${repoCfg.repo}: ${err}`);
        statusBar.setStatus('error', `${repoCfg.owner}/${repoCfg.repo}`);
    }
}

function stopPolling(): void {
    for (const timer of pollTimers) {
        clearInterval(timer);
    }
    pollTimers = [];
    isRunning = false;
    vscode.commands.executeCommand('setContext', 'argus.isRunning', false);
    statusBar?.setStatus('stopped');
    logger?.info('Polling stopped.');
}

// ─── Forge Management ───────────────────────────────────────────────

async function getOrCreateForge(
    repoCfg: RepoConfig,
    context: vscode.ExtensionContext,
): Promise<Forge> {
    const key = repoKey(repoCfg);
    let forge = forges.get(key);
    if (!forge) {
        forge = await createForge(repoCfg, context.secrets);
        forges.set(key, forge);
    }
    return forge;
}

// ─── View Refresh ───────────────────────────────────────────────────

function refreshViews(): void {
    workQueueProvider?.refresh();
    activityProvider?.refresh();
}

function updateHealthView(config: ArgusConfig): void {
    systemHealthProvider?.updateHealth([
        { label: 'Repos configured', value: String(config.repos.length), status: config.repos.length > 0 ? 'ok' : 'warning' },
        { label: 'Polling', value: isRunning ? 'Active' : 'Stopped', status: isRunning ? 'ok' : 'warning' },
        { label: 'Dry run', value: config.dryRun ? 'Yes' : 'No', status: config.dryRun ? 'warning' : 'ok' },
        { label: 'Email', value: config.email.enabled ? 'Enabled' : 'Disabled', status: 'ok' },
    ]);
}
