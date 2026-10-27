// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT
// Repo Settings page. Static, CSP-locked: data arrives via postMessage and is
// rendered with textContent / DOM properties only (never innerHTML).
// @ts-check
(function () {
    'use strict';
    // eslint-disable-next-line no-undef
    const vscode = acquireVsCodeApi();
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    /** @type {Record<string, HTMLElement>} */
    let errors = {};
    /** @type {Record<string, HTMLInputElement>} */
    let inputs = {};

    function h(tag, props, children) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(props || {})) {
            if (v === undefined || v === null) { continue; }
            if (k === 'class') { el.className = v; } else if (k === 'text') { el.textContent = v; } else if (k in el) { /** @type {any} */ (el)[k] = v; } else { el.setAttribute(k, String(v)); }
        }
        for (const c of children || []) {
            if (c === null || c === undefined) { continue; }
            el.append(typeof c === 'string' ? document.createTextNode(c) : c);
        }
        return el;
    }

    function textField(id, label, value, placeholder, type) {
        const input = /** @type {HTMLInputElement} */ (h('input', { type: type || 'text', id, value, placeholder }));
        inputs[id] = input;
        errors[id] = h('p', { class: 'error', hidden: true });
        return h('div', { class: 'field' }, [h('label', { htmlFor: id, text: label }), input, errors[id]]);
    }

    function render(d) {
        errors = {};
        inputs = {};
        app.replaceChildren();
        app.removeAttribute('aria-busy');
        const smtp = d.smtp || {};

        const secure = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: 'smtpSecure', checked: smtp.secure === true }));
        inputs.smtpSecure = secure;
        errors.smtpSecure = h('p', { class: 'error', hidden: true });
        errors._form = h('p', { class: 'error form-error', hidden: true });

        const save = h('button', { class: 'btn-primary', type: 'button', text: 'Save' });
        save.addEventListener('click', doSave);
        const cancel = h('button', { class: 'btn-secondary', type: 'button', text: 'Close' });
        cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

        app.append(
            h('h1', { text: String(d.title || '') }),
            h('p', { class: 'subtitle', text: String(d.forge || '') + ' repository' }),
            h('div', { class: 'section' }, [
                h('div', { class: 'section-title', text: 'Email notifications' }),
                textField('recipients', 'Recipients', (Array.isArray(d.recipients) ? d.recipients : []).join(', '), 'john@example.com, jane@example.com'),
                h('p', { class: 'help', text: 'Comma-separated. Leave blank to use the global default recipients.' }),
            ]),
            h('div', { class: 'section' }, [
                h('div', { class: 'section-title', text: 'SMTP override (optional)' }),
                h('p', { class: 'help', text: 'Only fill these in if this repo should send through a different SMTP server. Blank fields inherit the global Argus SMTP settings.' }),
                textField('smtpHost', 'SMTP host', String(smtp.host || ''), 'smtp.example.com'),
                textField('smtpPort', 'Port', typeof smtp.port === 'number' ? String(smtp.port) : '', '587', 'number'),
                textField('smtpUser', 'SMTP user', String(smtp.user || ''), 'alerts@example.com'),
                h('div', { class: 'field' }, [
                    h('div', { class: 'checkbox-row' }, [secure, h('label', { htmlFor: 'smtpSecure', text: 'Use SSL (port 465)' })]),
                    errors.smtpSecure,
                ]),
            ]),
            errors._form,
            h('div', { class: 'btn-row' }, [save, cancel]),
        );
    }

    function doSave() {
        for (const e of Object.values(errors)) { e.hidden = true; e.textContent = ''; }
        const port = inputs.smtpPort.value.trim();
        vscode.postMessage({
            type: 'save',
            data: {
                recipients: inputs.recipients.value.split(',').map((s) => s.trim()).filter(Boolean),
                smtpHost: inputs.smtpHost.value.trim(),
                smtpPort: port === '' ? null : Number(port),
                smtpSecure: inputs.smtpSecure.checked,
                smtpUser: inputs.smtpUser.value.trim(),
            },
        });
    }

    function onSaved(msg) {
        if (msg.ok) { return; }
        for (const [k, v] of Object.entries(msg.errors || {})) {
            const el = errors[k] || errors._form;
            if (el) { el.textContent = String(v); el.hidden = false; }
        }
    }

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || typeof msg.type !== 'string') { return; }
        if (msg.type === 'init') { render(msg); }
        if (msg.type === 'saved') { onSaved(msg); }
    });

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            doSave();
        }
    });

    vscode.postMessage({ type: 'ready' });
})();
