// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Email — SMTP email delivery via nodemailer.
 *
 * Supports per-repo overrides: each repo can define its own recipients and,
 * optionally, its own SMTP server. When a repo has no email config (or only
 * partial config), the global Argus settings fill in the gaps.
 */

import type { Logger } from '../util/logger';
import type { RepoKey } from '../forge/types';

// nodemailer is a runtime dependency — import lazily
let nodemailer: any;

/** SMTP connection details (shared by global and per-repo configs). */
export interface SmtpConfig {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;            // from SecretStorage
}

/** Per-repo email overrides stored alongside the repo definition. */
export interface RepoEmailOverride {
    /** Recipients for this repo. Overrides the global list when set. */
    recipients: string[];
    /** Optional per-repo SMTP — if any field is missing, the global value fills in. */
    smtp?: Partial<SmtpConfig>;
}

/** Global email configuration. */
export interface EmailConfig {
    enabled: boolean;
    smtp: SmtpConfig;
    fromAddress: string;
    fromName: string;
    /** Default recipients when no per-repo override exists. */
    defaultRecipients: string[];
    /** Per-repo overrides keyed by RepoKey (e.g. "github:owner/repo"). */
    repoOverrides: Map<RepoKey, RepoEmailOverride>;
}

export interface EmailMessage {
    /** Explicit recipient list. If omitted, resolved from repo or global config. */
    to?: string[];
    subject: string;
    text: string;
    html?: string;
}

export class EmailSender {
    private globalTransporter: any;
    private repoTransporters = new Map<RepoKey, any>();
    private config: EmailConfig;

    constructor(
        config: EmailConfig,
        private readonly logger: Logger,
    ) {
        this.config = config;
    }

    /** Initialize the global SMTP transporter. Call once after config is loaded. */
    async initialize(): Promise<void> {
        if (!this.config.enabled) {
            this.logger.info('Email notifications disabled');
            return;
        }

        try {
            nodemailer = await import('nodemailer');
        } catch {
            this.logger.warn('nodemailer not installed — email notifications unavailable');
            return;
        }

        this.globalTransporter = await this.createTransporter(this.config.smtp, 'global');

        // Pre-create per-repo transporters that define their own SMTP
        for (const [repoKey, override] of this.config.repoOverrides) {
            if (override.smtp && override.smtp.host) {
                const merged = this.mergeSmtp(override.smtp);
                const transport = await this.createTransporter(merged, repoKey);
                if (transport) {
                    this.repoTransporters.set(repoKey, transport);
                }
            }
        }
    }

    /**
     * Send an email, optionally scoped to a repository.
     *
     * When `repoKey` is provided:
     *  1. Uses the repo's SMTP transport if it has one, else the global transport.
     *  2. Uses the repo's recipients if configured, else the global default.
     *
     * When `repoKey` is omitted, global config is used for everything.
     */
    async send(message: EmailMessage, repoKey?: RepoKey): Promise<boolean> {
        if (!this.config.enabled) { return false; }

        const transporter = this.resolveTransporter(repoKey);
        if (!transporter) { return false; }

        const recipients = message.to || this.resolveRecipients(repoKey);
        if (recipients.length === 0) {
            this.logger.debug(`No email recipients for ${repoKey ?? 'global'} — skipping`);
            return false;
        }

        try {
            const info = await transporter.sendMail({
                from: `"${this.config.fromName}" <${this.config.fromAddress}>`,
                to: recipients.join(', '),
                subject: message.subject,
                text: message.text,
                html: message.html,
            });

            this.logger.debug(`Email sent to [${recipients.join(', ')}]: ${info.messageId}`);
            return true;
        } catch (err) {
            this.logger.error(`Failed to send email: ${err}`);
            return false;
        }
    }

    /** Update config at runtime (e.g., when settings change). */
    updateConfig(config: Partial<EmailConfig>): void {
        this.config = { ...this.config, ...config };
    }

    dispose(): void {
        this.globalTransporter?.close();
        this.globalTransporter = null;
        for (const t of this.repoTransporters.values()) { t.close(); }
        this.repoTransporters.clear();
    }

    // ── Private ─────────────────────────────────────────────────────

    /** Resolve the best transporter for a repo — repo-specific first, then global. */
    private resolveTransporter(repoKey?: RepoKey): any {
        if (repoKey) {
            const repoTransport = this.repoTransporters.get(repoKey);
            if (repoTransport) { return repoTransport; }
        }
        return this.globalTransporter;
    }

    /** Resolve recipients — repo-specific first, then global default. */
    private resolveRecipients(repoKey?: RepoKey): string[] {
        if (repoKey) {
            const override = this.config.repoOverrides.get(repoKey);
            if (override && override.recipients.length > 0) {
                return override.recipients;
            }
        }
        return this.config.defaultRecipients;
    }

    /** Merge a partial per-repo SMTP config with the global one. */
    private mergeSmtp(partial: Partial<SmtpConfig>): SmtpConfig {
        return {
            host: partial.host ?? this.config.smtp.host,
            port: partial.port ?? this.config.smtp.port,
            secure: partial.secure ?? this.config.smtp.secure,
            user: partial.user ?? this.config.smtp.user,
            pass: partial.pass ?? this.config.smtp.pass,
        };
    }

    /** Create and verify an SMTP transport. Returns null on failure. */
    private async createTransporter(smtp: SmtpConfig, label: string): Promise<any> {
        if (!smtp.host) {
            this.logger.debug(`No SMTP host for ${label} — transport not created`);
            return null;
        }

        const transport = nodemailer.createTransport({
            host: smtp.host,
            port: smtp.port,
            secure: smtp.secure,
            auth: {
                user: smtp.user,
                pass: smtp.pass,
            },
        });

        try {
            await transport.verify();
            this.logger.info(`SMTP connection verified (${label})`);
            return transport;
        } catch (err) {
            this.logger.error(`SMTP verification failed (${label}): ${err}`);
            return null;
        }
    }
}
