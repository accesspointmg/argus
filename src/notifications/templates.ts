// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Email templates. Every interpolated value is escaped: titles and details
 * often contain issue text written by strangers.
 */

import type { RepoKey } from '../forge/types';
import type { EmailEventName } from '../util/config';
import type { EmailMessage } from './email';

export function escapeHtml(str: string): string {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const HEADINGS: Record<EmailEventName, { icon: string; label: string; color: string }> = {
    prOpened: { icon: '📤', label: 'Pull request opened', color: '#0969da' },
    prStuck: { icon: '🧱', label: 'Argus is stuck', color: '#9a6700' },
    ciPassedFinal: { icon: '✅', label: 'CI passing', color: '#1a7f37' },
    threatDetected: { icon: '⚠️', label: 'Threat detected', color: '#cf222e' },
    userBlocked: { icon: '⛔', label: 'User blocked', color: '#cf222e' },
    emergencyStop: { icon: '🛑', label: 'Emergency stop', color: '#cf222e' },
    rateLimitWarning: { icon: '⏳', label: 'Rate limit reached', color: '#9a6700' },
    anomalyDetected: { icon: '🚨', label: 'Anomaly detected', color: '#cf222e' },
    systemError: { icon: '❗', label: 'Error', color: '#cf222e' },
};

/** Only http(s) links are rendered; anything else is shown as text. */
function safeUrl(url: string | undefined): string | undefined {
    return url && /^https?:\/\//i.test(url) ? url : undefined;
}

/** Subjects are single-line and bounded; nodemailer encodes the rest. */
function subjectLine(text: string): string {
    const one = text.replace(/[\r\n]+/g, ' ').trim();
    return one.length > 150 ? `${one.slice(0, 150)}…` : one;
}

export function notificationEmail(
    event: EmailEventName,
    repo: RepoKey | undefined,
    details: { title: string; detail?: string; url?: string },
): EmailMessage {
    const h = HEADINGS[event];
    const url = safeUrl(details.url);
    const repoText = repo ?? 'all repositories';

    const text = [
        `${h.label} — ${repoText}`,
        '',
        details.title,
        details.detail ? `\n${details.detail}` : '',
        url ? `\n${url}` : '',
    ].join('\n');

    const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px">
  <h2 style="color:${h.color}">${h.icon} ${escapeHtml(h.label)}</h2>
  <p style="color:#57606a">${escapeHtml(repoText)}</p>
  <p><strong>${escapeHtml(details.title)}</strong></p>
  ${details.detail ? `<pre style="white-space:pre-wrap;background:#f6f8fa;padding:12px;border-radius:6px">${escapeHtml(details.detail.slice(0, 4000))}</pre>` : ''}
  ${url ? `<p><a href="${escapeHtml(url)}">Open →</a></p>` : ''}
</div>`;

    return { subject: subjectLine(`[Argus] ${h.label}: ${details.title}`), text, html };
}
