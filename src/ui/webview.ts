// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Shared webview plumbing: a strict-CSP HTML shell and panel options.
 *
 * Pages are static — markup, styles and script live under `media/webview/`.
 * Nothing user- or config-derived is interpolated into HTML or JS; data goes
 * to the page by `postMessage` after it reports `ready`, and the page builds
 * its DOM with `textContent`.
 */

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';

export function webviewRoot(extensionUri: vscode.Uri): vscode.Uri {
    return vscode.Uri.joinPath(extensionUri, 'media', 'webview');
}

export function panelOptions(extensionUri: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
        enableScripts: true,
        enableCommandUris: false,
        enableForms: false,
        retainContextWhenHidden: true,
        localResourceRoots: [webviewRoot(extensionUri)],
    };
}

/** Escape for HTML text and attribute contexts (including single quotes). */
export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Build the page shell. `script` is a file name under `media/webview/`; the
 * shared stylesheet is always loaded. A fresh nonce is minted per render.
 */
export function renderShell(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    opts: { title: string; script: string },
): string {
    const nonce = randomBytes(16).toString('hex');
    const root = webviewRoot(extensionUri);
    const css = webview.asWebviewUri(vscode.Uri.joinPath(root, 'settings.css')).toString();
    const js = webview.asWebviewUri(vscode.Uri.joinPath(root, opts.script)).toString();
    const csp = [
        `default-src 'none'`,
        `style-src ${webview.cspSource} 'nonce-${nonce}'`,
        `script-src 'nonce-${nonce}'`,
        `img-src ${webview.cspSource}`,
        `font-src ${webview.cspSource}`,
        `base-uri 'none'`,
        `form-action 'none'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(opts.title)}</title>
<link rel="stylesheet" nonce="${nonce}" href="${escapeHtml(css)}">
</head>
<body>
<main id="app" aria-busy="true"><p class="help">Loading…</p></main>
<script nonce="${nonce}" src="${escapeHtml(js)}"></script>
</body>
</html>`;
}

/** Bounded, single-line text from an unknown error for display. */
export function errorText(err: unknown, max = 300): string {
    const s = err instanceof Error ? err.message : String(err);
    return s.replace(/\s+/g, ' ').slice(0, max);
}
