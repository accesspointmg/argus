// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Argus VS Code extension entry point: builds the subsystems, hands them to
 * the {@link ArgusController}, and registers commands and views.
 */

import * as vscode from 'vscode';

import { Logger } from './util/logger';
import { readConfig, parseRepoInput, formatRepoString, addRepoToSettings, removeRepoFromSettings } from './util/config';
import type { ArgusConfig } from './util/config';

import { hasToken, promptAndStoreToken, clearToken as clearForgeToken } from './forge/factory';
import type { ForgePlatform, RepoConfig } from './forge/types';
import { repoKey } from './forge/types';

import { KeyManager } from './crypto/keys';
import { StampManager } from './crypto/stamp';
import { NonceRegistry } from './crypto/nonce-registry';
import { AuditLog } from './crypto/audit';

import { LlmService } from './llm';
import { selectAiProvider, promptAndStoreApiKey, checkClaudeLogin } from './llm/setup';

import { Sanitizer } from './security/sanitizer';
import { ThreatClassifier } from './security/threat-classifier';
import { TrustManager } from './security/trust';
import { OutputValidator } from './security/validator';
import { DiffAssessor } from './security/diff-assessor';

import { Evaluator } from './agent/evaluator';
import { Investigator } from './agent/investigator';
import { Coder } from './agent/coder';
import { Transcriber } from './agent/transcriber';
import { CommentHandler } from './agent/comment-handler';
import { EditDetector } from './agent/edit-detector';
import { PRAnalyzer } from './agent/pr-analyzer';
import { PRGatekeeper } from './agent/pr-gatekeeper';
import { ArgusController } from './agent/controller';
import { StateStore } from './agent/state-store';
import type { TrackedIssue } from './agent/types';

import { EmailSender } from './notifications/email';
import { NotificationRouter } from './notifications/events';

import { WorkQueueProvider, ActivityProvider, RepoStatsProvider, SecurityProvider, SystemHealthProvider } from './ui/treeview';
import { StatusBar } from './ui/statusbar';
import { RepoSettingsPanel } from './ui/repo-settings-panel';
import { ArgusSettingsPanel } from './ui/argus-settings-panel';

const SMTP_SECRET = 'argus.smtpPassword';

let controller: ArgusController | undefined;
let flushNonces: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const logger = new Logger('Argus', readConfig().logLevel);
    context.subscriptions.push(logger);
    logger.info('Argus activating…');

    // ── Crypto ──
    const keyManager = new KeyManager(context.secrets, context.globalState);
    await keyManager.initialize();
    if (await keyManager.rotateIfDue()) {
        logger.info('Instance key rotated (argus.crypto.keyRotationDays).');
    }
    const nonceRegistry = new NonceRegistry(context.globalState);
    await nonceRegistry.load();
    flushNonces = () => nonceRegistry.flush();
    const stampManager = new StampManager(keyManager, nonceRegistry);

    const auditChannel = vscode.window.createOutputChannel('Argus Audit Log');
    context.subscriptions.push(auditChannel);
    const auditLog = new AuditLog(keyManager, context.globalState, auditChannel);
    await auditLog.load();

    // ── Model ──
    const llm = new LlmService(context.secrets, logger);

    // ── Security ──
    const sanitizer = new Sanitizer();
    const threatClassifier = new ThreatClassifier(logger, llm);
    const trust = new TrustManager(context.globalState, logger);
    const validator = new OutputValidator();
    const diffAssessor = new DiffAssessor(logger, sanitizer, llm);

    // ── Notifications ──
    const emailSender = new EmailSender(await emailConfig(context), logger);
    await emailSender.initialize();
    const notifier = new NotificationRouter(emailSender, logger);

    // ── Agents ──
    const store = new StateStore(context.globalState);
    controller = new ArgusController({
        evaluator: new Evaluator(logger, sanitizer, llm),
        investigator: new Investigator(logger, llm),
        coder: new Coder(logger, validator, stampManager, auditLog, llm),
        transcriber: new Transcriber(logger, stampManager),
        commentHandler: new CommentHandler(logger, sanitizer, threatClassifier, trust, auditLog),
        editDetector: new EditDetector(logger, auditLog),
        prAnalyzer: new PRAnalyzer(logger, trust, stampManager, llm),
        gatekeeper: new PRGatekeeper(diffAssessor, trust, stampManager, auditLog, logger, context.globalState),
        stampManager,
        auditLog,
        sanitizer,
        trust,
        notifier,
        store,
        secrets: context.secrets,
        llm,
        logger,
    });
    context.subscriptions.push(controller);
    const ctl = controller;

    // ── UI ──
    const statusBar = new StatusBar();
    const workQueue = new WorkQueueProvider({ getQueue: () => ctl.getQueue() });
    const activity = new ActivityProvider({ getActivity: (limit?: number) => ctl.getActivity(limit) });
    const repoStats = new RepoStatsProvider();
    const security = new SecurityProvider();
    const health = new SystemHealthProvider();

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('argus.workQueue', workQueue),
        vscode.window.registerTreeDataProvider('argus.recentActivity', activity),
        vscode.window.registerTreeDataProvider('argus.repoStats', repoStats),
        vscode.window.registerTreeDataProvider('argus.security', security),
        vscode.window.registerTreeDataProvider('argus.systemHealth', health),
        statusBar,
    );

    const refresh = (): void => {
        workQueue.refresh();
        activity.refresh();
        repoStats.refresh();
        statusBar.setStatus(ctl.isHalted ? 'error' : ctl.isRunning ? (ctl.status === 'polling' ? 'polling' : 'idle') : 'stopped',
            ctl.isHalted ? 'Emergency stopped' : undefined);
        void vscode.commands.executeCommand('setContext', 'argus.isRunning', ctl.isRunning);
        void updateHealth(health, ctl, llm);
    };
    context.subscriptions.push(ctl.onDidChange(refresh));

    // ── Helpers ──
    const pickRepo = async (title: string): Promise<RepoConfig | undefined> => {
        const repos = readConfig().repos;
        if (repos.length === 0) {
            void vscode.window.showInformationMessage('No repositories configured. Use "Argus: Add Repository" first.');
            return undefined;
        }
        if (repos.length === 1) { return repos[0]; }
        const picked = await vscode.window.showQuickPick(
            repos.map((r) => ({ label: `$(repo) ${r.owner}/${r.repo}`, description: r.forge, repo: r })),
            { title },
        );
        return picked?.repo;
    };

    const setTokenContext = async (): Promise<void> => {
        await vscode.commands.executeCommand('setContext', 'argus.hasGitHubToken', await hasToken('github', context.secrets));
        await vscode.commands.executeCommand('setContext', 'argus.hasGitLabToken', await hasToken('gitlab', context.secrets));
    };

    const command = (id: string, fn: (...args: unknown[]) => unknown): vscode.Disposable =>
        vscode.commands.registerCommand(id, async (...args: unknown[]) => {
            try {
                await fn(...args);
            } catch (err) {
                logger.error(`${id} failed: ${err}`);
                void vscode.window.showErrorMessage(`Argus: ${err instanceof Error ? err.message : String(err)}`);
            }
        });

    // ── Commands ──
    context.subscriptions.push(
        command('argus.start', async () => {
            if (ctl.isRunning) {
                void vscode.window.showInformationMessage('Argus is already running.');
                return;
            }
            if (readConfig().repos.length === 0) {
                void vscode.window.showWarningMessage('Add a repository before starting Argus.');
                return;
            }
            await ctl.start();
            if (readConfig().dryRun) {
                void vscode.window.showInformationMessage('Argus started in dry-run mode — it will not write anything.');
            }
        }),

        command('argus.stop', () => {
            ctl.stop();
            void vscode.window.showInformationMessage('Argus stopped.');
        }),

        command('argus.emergencyStop', async () => {
            await ctl.emergencyStop();
            logger.warn('EMERGENCY STOP triggered');
            void vscode.window.showWarningMessage('Argus emergency stopped. In-flight work was aborted and writes are blocked until you start it again.');
        }),

        command('argus.pollNow', async () => {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: 'Argus: polling…' },
                () => ctl.pollNow(),
            );
        }),

        command('argus.processIssue', async () => {
            const repo = await pickRepo('Process issue in which repository?');
            if (!repo) { return; }
            const input = await vscode.window.showInputBox({
                prompt: `Issue number in ${repo.owner}/${repo.repo}`,
                placeHolder: '42',
                validateInput: (v) => (/^\d+$/.test(v.trim()) ? undefined : 'Enter an issue number'),
            });
            if (!input) { return; }
            const tracked = await ctl.processIssue(repo, Number(input.trim()));
            void vscode.window.showInformationMessage(
                `#${tracked.issueNumber} queued.${ctl.isRunning ? '' : ' Start Argus or run "Poll Now" to process it.'}`,
            );
        }),

        command('argus.skipIssue', async (arg) => {
            const issue = issueFromArg(arg);
            if (issue && !(await ctl.skip(issue))) {
                void vscode.window.showWarningMessage(`#${issue.issueNumber} is being processed and can't be skipped right now.`);
            }
        }),

        command('argus.reprocessIssue', async (arg) => {
            const issue = issueFromArg(arg);
            if (issue && !(await ctl.reprocess(issue))) {
                void vscode.window.showWarningMessage(`#${issue.issueNumber} is being processed right now.`);
            }
        }),

        command('argus.promoteIssue', async (arg) => {
            const issue = issueFromArg(arg);
            if (issue) { await ctl.promote(issue); }
        }),

        command('argus.clearQueue', async () => {
            const removed = await ctl.clearPending();
            void vscode.window.showInformationMessage(`Removed ${removed} pending issue(s) from the queue.`);
        }),

        command('argus.openInBrowser', async (arg) => {
            const url = urlFromArg(arg);
            if (url) { await vscode.env.openExternal(vscode.Uri.parse(url)); }
        }),

        command('argus.viewTranscript', async (arg) => {
            const issue = issueFromArg(arg);
            const url = issue?.prUrl ?? issue?.url;
            if (url) {
                await vscode.env.openExternal(vscode.Uri.parse(url));
            } else {
                logger.show();
            }
        }),

        command('argus.showActivityLog', () => logger.show()),
        command('argus.showSecurityLog', () => auditChannel.show(true)),
        command('argus.configureRepos', () => vscode.commands.executeCommand('workbench.action.openSettings', 'argus.repos')),

        command('argus.selectAiProvider', async () => {
            await selectAiProvider(context.secrets);
            logger.info(`AI provider is now ${await llm.describe()}.`);
            refresh();
        }),
        command('argus.setAiKey', () => promptAndStoreApiKey(context.secrets)),
        command('argus.checkClaudeLogin', async () => {
            const status = await checkClaudeLogin();
            const show = status.ok ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
            void show(status.message);
            return status;
        }),

        command('argus.setGitHubToken', async () => {
            if (await promptAndStoreToken('github', context.secrets)) {
                ctl.invalidateForges();
                await setTokenContext();
                void vscode.window.showInformationMessage('GitHub token saved.');
            }
        }),
        command('argus.setGitLabToken', async () => {
            if (await promptAndStoreToken('gitlab', context.secrets)) {
                ctl.invalidateForges();
                await setTokenContext();
                void vscode.window.showInformationMessage('GitLab token saved.');
            }
        }),
        command('argus.clearTokens', async () => {
            // github.com / gitlab.com plus any self-hosted servers in the repo list (tokens are per host).
            const hosts = new Map<string, { platform: ForgePlatform; host?: string }>([
                ['github', { platform: 'github' }],
                ['gitlab', { platform: 'gitlab' }],
            ]);
            for (const r of readConfig().repos) {
                if (r.host) { hosts.set(`${r.forge}:${r.host}`, { platform: r.forge, host: r.host }); }
            }
            const pick = await vscode.window.showQuickPick(
                [...hosts.values()].map((h) => ({
                    label: `${h.platform === 'github' ? '$(mark-github) GitHub' : '$(git-merge) GitLab'} token`,
                    description: h.host ?? (h.platform === 'github' ? 'github.com' : 'gitlab.com'),
                    ...h,
                })),
                { title: 'Clear Token', placeHolder: 'Which token to remove?' },
            );
            if (!pick) { return; }
            await clearForgeToken(pick.platform, context.secrets, pick.host);
            ctl.invalidateForges();
            await setTokenContext();
            void vscode.window.showInformationMessage(`Token for ${pick.description} cleared.`);
        }),

        command('argus.setSmtpPassword', async () => {
            const password = await vscode.window.showInputBox({
                title: 'Set SMTP Password',
                prompt: 'SMTP password (or app password) for Argus email notifications',
                password: true,
                ignoreFocusOut: true,
                validateInput: (v) => (v.trim() ? undefined : 'Password cannot be empty'),
            });
            if (!password) { return; }
            await context.secrets.store(SMTP_SECRET, password.trim());
            await emailSender.reconfigure(await emailConfig(context));
            void vscode.window.showInformationMessage('SMTP password saved.');
        }),

        command('argus.addRepo', async () => {
            const input = await vscode.window.showInputBox({
                title: 'Add Repository',
                prompt: 'Repository URL or owner/repo',
                placeHolder: 'https://github.com/owner/repo',
                ignoreFocusOut: true,
                validateInput: (value) => (parseRepoInput(value) ? undefined
                    : 'Could not parse. Try https://github.com/owner/repo, git@gitlab.example.com:group/repo.git, or owner/repo'),
            });
            if (!input) { return; }
            const parsed = parseRepoInput(input);
            if (!parsed) { return; }

            if (!(await hasToken(parsed.forge, context.secrets, parsed.host))) {
                const label = parsed.forge === 'gitlab' ? 'GitLab' : 'GitHub';
                const choice = await vscode.window.showWarningMessage(
                    `No ${label} token configured. A token is required to watch a ${label} repository.`,
                    'Set Token Now', 'Cancel',
                );
                if (choice !== 'Set Token Now' || !(await promptAndStoreToken(parsed.forge, context.secrets, parsed.host))) { return; }
                await setTokenContext();
            }

            if (!(await addRepoToSettings(input))) {
                void vscode.window.showInformationMessage('That repository is already in the watch list.');
                return;
            }
            ctl.reload();
            const label = formatRepoString(parsed);
            void vscode.window.showInformationMessage(`Added ${label}.`);
            await reportTokenProblems(ctl, parsed, logger);
        }),

        command('argus.removeRepo', async () => {
            const repo = await pickRepo('Remove which repository?');
            if (!repo) { return; }
            const confirm = await vscode.window.showWarningMessage(
                `Stop watching ${formatRepoString(repo)}? Its queue and history will be forgotten.`,
                { modal: true }, 'Remove',
            );
            if (confirm !== 'Remove') { return; }
            if (await removeRepoFromSettings(repo)) {
                await ctl.forgetRepo(repo);
                void vscode.window.showInformationMessage(`Removed ${formatRepoString(repo)}.`);
            }
        }),

        command('argus.listRepos', async () => {
            const repo = await pickRepo('Configure which repository?');
            if (!repo) { return; }
            const raw = vscode.workspace.getConfiguration('argus').get<unknown[]>('repos', []) ?? [];
            RepoSettingsPanel.show(context.extensionUri, repo, raw as never, async (updated) => {
                await vscode.workspace.getConfiguration('argus').update('repos', updated, vscode.ConfigurationTarget.Global);
            });
        }),

        command('argus.openSettings', () => ArgusSettingsPanel.show(context.extensionUri, context.secrets)),

        command('argus.resetTrustData', async () => {
            const confirm = await vscode.window.showWarningMessage(
                'Forget all recorded trust history (flags and blocks) and cached lookups?', { modal: true }, 'Reset',
            );
            if (confirm === 'Reset') {
                await trust.reset();
                void vscode.window.showInformationMessage('Trust data reset.');
            }
        }),

        command('argus.verifyAuditLog', async () => {
            const result = await auditLog.verifyChain();
            if (result.valid) {
                void vscode.window.showInformationMessage(`Audit log verified: ${auditLog.totalEntries} entries, chain intact.`);
            } else {
                void vscode.window.showErrorMessage(`Audit log verification FAILED at entry ${result.brokenAt}: ${result.errors.join('; ')}`);
            }
        }),

        command('argus.rotateKey', async () => {
            await keyManager.rotateKey();
            void vscode.window.showInformationMessage('Instance key rotated. Older stamps still verify.');
        }),

        command('argus.exportReport', async () => {
            const doc = await vscode.workspace.openTextDocument({
                language: 'markdown',
                content: await buildReport(ctl, auditLog, llm),
            });
            await vscode.window.showTextDocument(doc);
        }),
    );

    // ── Settings changes apply live ──
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (!e.affectsConfiguration('argus')) { return; }
            const cfg = readConfig();
            logger.setLevel(cfg.logLevel);
            if (e.affectsConfiguration('argus.repos') || e.affectsConfiguration('argus.rateLimits') ||
                e.affectsConfiguration('argus.pollIntervalMinutes')) {
                ctl.reload();
            }
            if (e.affectsConfiguration('argus.email') || e.affectsConfiguration('argus.repos')) {
                await emailSender.reconfigure(await emailConfig(context));
            }
            refresh();
        }),
    );

    await setTokenContext();
    refresh();

    const cfg = readConfig();
    if (cfg.autoStartOnActivation && cfg.repos.length > 0) {
        await ctl.start();
    }
    logger.info('Argus activated.');
}

export async function deactivate(): Promise<void> {
    await controller?.shutdown();
    controller = undefined;
    await flushNonces?.();
}

// ─── Helpers ────────────────────────────────────────────────────

async function emailConfig(context: vscode.ExtensionContext): Promise<ArgusConfig['email']> {
    const cfg = readConfig().email;
    cfg.smtp.pass = (await context.secrets.get(SMTP_SECRET)) ?? '';
    return cfg;
}

/** Tree items carry the issue as `issue`; commands may also get a TrackedIssue directly. */
function issueFromArg(arg: unknown): TrackedIssue | undefined {
    const a = arg as { issue?: TrackedIssue } & Partial<TrackedIssue> | undefined;
    if (a?.issue) { return a.issue; }
    if (a && typeof a.issueNumber === 'number' && typeof a.repo === 'string') { return a as TrackedIssue; }
    return undefined;
}

function urlFromArg(arg: unknown): string | undefined {
    const a = arg as { url?: string; issue?: TrackedIssue; entry?: { url?: string } } | undefined;
    const url = a?.url ?? a?.entry?.url ?? a?.issue?.prUrl ?? a?.issue?.url;
    return url && /^https?:\/\//i.test(url) ? url : undefined;
}

async function reportTokenProblems(ctl: ArgusController, repo: RepoConfig, logger: Logger): Promise<void> {
    try {
        const forge = await ctl.forgeFor(repo);
        const result = await forge.validateTokenScopes();
        const problems = [...result.errors, ...result.warnings];
        if (problems.length > 0) {
            logger.warn(`Token check for ${formatRepoString(repo)}: ${problems.join('; ')}`);
            void vscode.window.showWarningMessage(`Token check for ${repo.owner}/${repo.repo}: ${problems.join('; ')}`);
        }
    } catch (err) {
        logger.warn(`Could not validate token for ${formatRepoString(repo)}: ${err}`);
    }
}

async function updateHealth(health: SystemHealthProvider, ctl: ArgusController, llm: LlmService): Promise<void> {
    const cfg = readConfig();
    const ai = await llm.describe();
    health.updateHealth([
        { label: 'Status', value: ctl.isHalted ? 'Emergency stopped' : ctl.isRunning ? 'Running' : 'Stopped', status: ctl.isHalted ? 'error' : ctl.isRunning ? 'ok' : 'warning' },
        { label: 'Repos configured', value: String(cfg.repos.length), status: cfg.repos.length > 0 ? 'ok' : 'warning' },
        { label: 'AI provider', value: ai, status: ai === 'none' ? 'error' : 'ok' },
        { label: 'Model calls left this hour', value: String(llm.remainingCalls()), status: llm.remainingCalls() > 0 ? 'ok' : 'warning' },
        { label: 'Dry run', value: cfg.dryRun ? 'Yes' : 'No', status: cfg.dryRun ? 'warning' : 'ok' },
        { label: 'Email', value: cfg.email.enabled ? 'Enabled' : 'Disabled', status: 'ok' },
    ]);
}

async function buildReport(ctl: ArgusController, auditLog: AuditLog, llm: LlmService): Promise<string> {
    const cfg = readConfig();
    const queue = ctl.getQueue();
    const verify = await auditLog.verifyChain();
    const byState = new Map<string, number>();
    for (const q of queue) { byState.set(q.state, (byState.get(q.state) ?? 0) + 1); }
    const row = (cells: string[]): string => `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;

    return [
        `# Argus report — ${new Date().toISOString()}`,
        '',
        `- Status: ${ctl.isHalted ? 'emergency stopped' : ctl.isRunning ? 'running' : 'stopped'}${cfg.dryRun ? ' (dry run)' : ''}`,
        `- AI provider: ${await llm.describe()}`,
        `- Repositories: ${cfg.repos.map((r) => formatRepoString(r)).join(', ') || 'none'}`,
        `- Audit log: ${auditLog.totalEntries} entries, ${verify.valid ? 'chain intact' : `BROKEN at ${verify.brokenAt}`}`,
        '',
        '## Queue',
        '',
        [...byState].map(([s, n]) => `- ${s}: ${n}`).join('\n') || '_empty_',
        '',
        row(['Repo', 'Issue', 'State', 'PR', 'Note']),
        row(['---', '---', '---', '---', '---']),
        ...queue.map((q) => row([q.repo, `#${q.issueNumber} ${q.title}`, q.state, q.prNumber ? `#${q.prNumber}` : '', q.error ?? ''])),
        '',
        '## Recent activity',
        '',
        ...ctl.getActivity(100).map((a) => `- ${a.timestamp.toISOString()} ${a.icon} ${a.repo} ${a.message}`),
        '',
    ].join('\n');
}

// Exported for tests.
export const __test = { issueFromArg, urlFromArg, repoKey };
