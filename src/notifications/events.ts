// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Event routing — turns pipeline events into emails.
 *
 * Event names match `argus.email.events` in settings. Each event can be
 * switched off individually, and nothing is sent during `argus.email.quietHours`
 * except emergency stops. Sending never throws into the pipeline.
 */

import type { EmailSender } from './email';
import type { Logger } from '../util/logger';
import type { RepoKey } from '../forge/types';
import type { EmailEventName, EmailPolicy } from '../util/config';
import { readConfig } from '../util/config';
import { notificationEmail } from './templates';

export interface NotificationDetails {
    title: string;
    detail?: string;
    url?: string;
}

/** Events that ignore quiet hours. */
const URGENT: readonly EmailEventName[] = ['emergencyStop'];

/** Repeats of the same event+title inside this window are dropped. */
const DEDUPE_MS = 30 * 60 * 1000;

export class NotificationRouter {
    private recent = new Map<string, number>();

    constructor(
        private readonly emailSender: EmailSender,
        private readonly logger: Logger,
        private readonly policy: () => EmailPolicy = () => readConfig().emailPolicy,
        private readonly now: () => Date = () => new Date(),
    ) {}

    async notify(event: EmailEventName, repo: RepoKey | undefined, details: NotificationDetails): Promise<boolean> {
        try {
            const policy = this.policy();
            if (policy.events[event]?.enabled === false) { return false; }
            if (!URGENT.includes(event) && policy.quietHours && inQuietHours(this.now(), policy.quietHours)) {
                this.logger.debug(`Email for ${event} suppressed (quiet hours)`);
                return false;
            }

            const key = `${event}|${repo ?? ''}|${details.title}`;
            const last = this.recent.get(key);
            const nowMs = this.now().getTime();
            if (last && nowMs - last < DEDUPE_MS) { return false; }
            this.recent.set(key, nowMs);
            if (this.recent.size > 500) {
                for (const [k, t] of this.recent) {
                    if (nowMs - t > DEDUPE_MS) { this.recent.delete(k); }
                }
            }

            return await this.emailSender.send(notificationEmail(event, repo, details), repo);
        } catch (err) {
            this.logger.warn(`Failed to send ${event} email: ${err}`);
            return false;
        }
    }
}

/**
 * Whether `now` falls in the quiet window. Handles windows that cross
 * midnight (23:00–07:00). An unknown timezone falls back to UTC.
 */
export function inQuietHours(now: Date, quiet: { start: string; end: string; timezone: string }): boolean {
    const minutes = (hhmm: string): number => {
        const [h, m] = hhmm.split(':').map(Number);
        return h * 60 + m;
    };
    let local: number;
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: quiet.timezone || 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(now);
        const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
        const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
        local = h * 60 + m;
    } catch {
        local = now.getUTCHours() * 60 + now.getUTCMinutes();
    }
    const start = minutes(quiet.start);
    const end = minutes(quiet.end);
    if (start === end) { return false; }
    return start < end ? local >= start && local < end : local >= start || local < end;
}
