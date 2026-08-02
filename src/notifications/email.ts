// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Email — SMTP email delivery via nodemailer.
 */

import type { Logger } from '../util/logger';

// nodemailer is a runtime dependency — import lazily
let nodemailer: any;

export interface EmailConfig {
    enabled: boolean;
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUser: string;
    smtpPass: string;        // from SecretStorage
    fromAddress: string;
    fromName: string;
    toAddresses: string[];
}

export interface EmailMessage {
    to?: string[];
    subject: string;
    text: string;
    html?: string;
}

export class EmailSender {
    private transporter: any;
    private config: EmailConfig;

    constructor(
        config: EmailConfig,
        private readonly logger: Logger,
    ) {
        this.config = config;
    }

    /** Initialize the SMTP transporter. Call once after config is loaded. */
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

        this.transporter = nodemailer.createTransport({
            host: this.config.smtpHost,
            port: this.config.smtpPort,
            secure: this.config.smtpSecure,
            auth: {
                user: this.config.smtpUser,
                pass: this.config.smtpPass,
            },
        });

        try {
            await this.transporter.verify();
            this.logger.info('SMTP connection verified');
        } catch (err) {
            this.logger.error(`SMTP verification failed: ${err}`);
            this.transporter = null;
        }
    }

    /** Send an email. Returns true if sent successfully. */
    async send(message: EmailMessage): Promise<boolean> {
        if (!this.config.enabled || !this.transporter) {
            return false;
        }

        try {
            const info = await this.transporter.sendMail({
                from: `"${this.config.fromName}" <${this.config.fromAddress}>`,
                to: (message.to || this.config.toAddresses).join(', '),
                subject: message.subject,
                text: message.text,
                html: message.html,
            });

            this.logger.debug(`Email sent: ${info.messageId}`);
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
        if (this.transporter) {
            this.transporter.close();
            this.transporter = null;
        }
    }
}
