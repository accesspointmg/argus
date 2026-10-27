// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT
// Argus Settings page. Static, CSP-locked: all data arrives via postMessage
// and is rendered with textContent / DOM properties only (never innerHTML).
// @ts-check
(function () {
    'use strict';
    // eslint-disable-next-line no-undef
    const vscode = acquireVsCodeApi();
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));

    /** @type {Map<string, {item: any, row: HTMLElement, get: () => unknown, error: HTMLElement}>} */
    let fields = new Map();
    /** @type {Map<string, {row: HTMLElement, status: HTMLElement}>} */
    let actions = new Map();
    let activeTab = 'ai';
    let modelReq = 0;
    let dirty = false;
    let formError = /** @type {HTMLElement | null} */ (null);
    let notice = /** @type {HTMLElement | null} */ (null);
    /** Model widget state. */
    const model = { manual: false, current: '', select: /** @type {HTMLSelectElement|null} */ (null), input: /** @type {HTMLInputElement|null} */ (null), hint: /** @type {HTMLElement|null} */ (null), selectWrap: /** @type {HTMLElement|null} */ (null), inputWrap: /** @type {HTMLElement|null} */ (null), link: /** @type {HTMLAnchorElement|null} */ (null) };

    /**
     * @param {string} tag
     * @param {Record<string, any>} [props]
     * @param {(Node|string|null|undefined)[]} [children]
     */
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

    function domId(id) { return 'f-' + id.replace(/[^A-Za-z0-9_-]/g, '_'); }

    // ─── Rendering ───────────────────────────────────────────────

    function render(data) {
        fields = new Map();
        actions = new Map();
        model.manual = false;
        app.replaceChildren();
        app.removeAttribute('aria-busy');

        notice = h('div', { class: 'notice', hidden: true });
        app.append(h('h1', { text: 'Argus Settings' }), notice);

        const tabBar = h('div', { class: 'tabs', role: 'tablist' });
        app.append(tabBar);
        const panels = new Map();
        for (const t of data.tabs || []) {
            const btn = h('button', { class: 'tab', type: 'button', role: 'tab', text: String(t.label) });
            btn.dataset.tab = String(t.id);
            btn.addEventListener('click', () => selectTab(String(t.id)));
            tabBar.append(btn);
            const panel = h('section', { class: 'tab-content', role: 'tabpanel' });
            panel.dataset.tab = String(t.id);
            panels.set(String(t.id), { panel, sections: new Map() });
            app.append(panel);
        }

        for (const item of data.items || []) {
            const p = panels.get(item.tab);
            if (!p) { continue; }
            let container = p.panel;
            if (item.section) {
                container = p.sections.get(item.section);
                if (!container) {
                    container = h('div', { class: 'section' }, [h('div', { class: 'section-title', text: String(item.section) })]);
                    p.sections.set(item.section, container);
                    p.panel.append(container);
                }
            }
            container.append(item.kind === 'action' ? renderAction(item) : renderField(item));
        }

        // Hide tabs that ended up empty (settings not declared).
        for (const [id, p] of panels) {
            if (!p.panel.childElementCount) {
                p.panel.remove();
                const btn = tabBar.querySelector('[data-tab="' + CSS.escape(id) + '"]');
                if (btn) { btn.remove(); }
            }
        }

        formError = h('p', { class: 'error form-error', hidden: true });
        const save = h('button', { class: 'btn-primary', type: 'button', text: 'Save' });
        save.addEventListener('click', doSave);
        const cancel = h('button', { class: 'btn-secondary', type: 'button', text: 'Close' });
        cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
        app.append(formError, h('div', { class: 'btn-row' }, [save, cancel]));

        if (!panels.has(activeTab) || !tabBar.querySelector('[data-tab="' + CSS.escape(activeTab) + '"]')) {
            const first = tabBar.querySelector('.tab');
            activeTab = first ? String(/** @type {HTMLElement} */ (first).dataset.tab) : '';
        }
        selectTab(activeTab);
        applyProvider();
        if (fields.has('ai.model')) { fetchModels(); }
        dirty = false;
    }

    function selectTab(id) {
        activeTab = id;
        app.querySelectorAll('.tab').forEach((b) => {
            const on = /** @type {HTMLElement} */ (b).dataset.tab === id;
            b.classList.toggle('active', on);
            b.setAttribute('aria-selected', String(on));
        });
        app.querySelectorAll('.tab-content').forEach((p) => {
            /** @type {HTMLElement} */ (p).hidden = /** @type {HTMLElement} */ (p).dataset.tab !== id;
        });
        try { vscode.setState({ activeTab: id }); } catch { /* ignore */ }
    }

    function renderField(item) {
        const id = domId(item.id);
        const error = h('p', { class: 'error', hidden: true });
        const help = item.help ? h('p', { class: 'help', text: String(item.help) }) : null;
        let row;
        let get;

        switch (item.kind) {
            case 'boolean': {
                const input = h('input', { type: 'checkbox', id, checked: item.value === true });
                input.addEventListener('change', markDirty);
                row = h('div', { class: 'field' }, [
                    h('div', { class: 'checkbox-row' }, [input, h('label', { htmlFor: id, text: String(item.label) })]),
                    help, error,
                ]);
                get = () => /** @type {HTMLInputElement} */ (input).checked;
                break;
            }
            case 'enum': {
                const select = h('select', { id });
                for (const o of item.options || []) {
                    select.append(h('option', { value: String(o.value), text: String(o.label), selected: o.value === item.value }));
                }
                select.addEventListener('change', markDirty);
                if (item.id === 'ai.provider') {
                    select.addEventListener('change', () => {
                        model.current = '';
                        if (model.input) { model.input.value = ''; }
                        applyProvider();
                        fetchModels();
                    });
                }
                row = h('div', { class: 'field' }, [h('label', { htmlFor: id, text: String(item.label) }), select, help, error]);
                get = () => /** @type {HTMLSelectElement} */ (select).value;
                break;
            }
            case 'number': {
                const input = h('input', {
                    type: 'number', id,
                    value: typeof item.value === 'number' ? String(item.value) : '',
                    placeholder: item.defaultValue !== undefined && item.defaultValue !== null ? String(item.defaultValue) : '',
                });
                if (typeof item.min === 'number') { input.setAttribute('min', String(item.min)); }
                if (typeof item.max === 'number') { input.setAttribute('max', String(item.max)); }
                if (typeof item.step === 'number') { input.setAttribute('step', String(item.step)); } else { input.setAttribute('step', 'any'); }
                input.addEventListener('input', markDirty);
                row = h('div', { class: 'field' }, [h('label', { htmlFor: id, text: String(item.label) }), input, help, error]);
                get = () => {
                    const v = /** @type {HTMLInputElement} */ (input).value.trim();
                    return v === '' ? null : Number(v);
                };
                break;
            }
            case 'stringList': {
                const input = h('input', { type: 'text', id, value: (item.value || []).join(', '), placeholder: item.placeholder || '' });
                input.addEventListener('input', markDirty);
                row = h('div', { class: 'field' }, [h('label', { htmlFor: id, text: String(item.label) }), input, help, error]);
                get = () => /** @type {HTMLInputElement} */ (input).value.split(',').map((s) => s.trim()).filter(Boolean);
                break;
            }
            case 'model': {
                row = renderModel(item, id, help, error);
                get = modelValue;
                break;
            }
            default: {
                const input = h('input', { type: 'text', id, value: String(item.value ?? ''), placeholder: item.placeholder || '' });
                input.addEventListener('input', markDirty);
                row = h('div', { class: 'field' }, [h('label', { htmlFor: id, text: String(item.label) }), input, help, error]);
                get = () => /** @type {HTMLInputElement} */ (input).value;
            }
        }
        fields.set(item.id, { item, row, get, error });
        return row;
    }

    function renderModel(item, id, help, error) {
        model.current = String(item.value || '');
        model.select = /** @type {HTMLSelectElement} */ (h('select', { id: id + '-select' }));
        model.select.addEventListener('change', markDirty);
        model.input = /** @type {HTMLInputElement} */ (h('input', { type: 'text', id, value: model.current, placeholder: 'Leave blank for the provider default' }));
        model.input.addEventListener('input', markDirty);
        model.link = /** @type {HTMLAnchorElement} */ (h('a', { href: '#', text: 'Enter manually instead' }));
        model.link.addEventListener('click', (e) => {
            e.preventDefault();
            const v = model.select && model.select.value;
            if (v && model.input) { model.input.value = v; }
            showModelMode('manual');
        });
        const refresh = h('a', { href: '#', text: 'Refresh list' });
        refresh.addEventListener('click', (e) => { e.preventDefault(); fetchModels(); });
        model.hint = h('p', { class: 'help' });
        model.selectWrap = h('div', { hidden: true }, [model.select, h('p', { class: 'help' }, [model.link])]);
        model.inputWrap = h('div', {}, [model.input]);
        return h('div', { class: 'field' }, [
            h('label', { htmlFor: id, text: String(item.label) }),
            model.selectWrap, model.inputWrap, model.hint,
            h('p', { class: 'help' }, [refresh]),
            help, error,
        ]);
    }

    function modelValue() {
        if (model.manual || !model.selectWrap || model.selectWrap.hidden) { return model.input ? model.input.value : ''; }
        return model.select ? model.select.value : '';
    }

    function showModelMode(mode) {
        model.manual = mode === 'manual';
        if (model.selectWrap) { model.selectWrap.hidden = mode !== 'select'; }
        if (model.inputWrap) { model.inputWrap.hidden = mode === 'select'; }
    }

    function renderAction(item) {
        const status = h('span', { class: 'status', text: String(item.status || '') });
        const btn = h('button', { class: 'btn-secondary btn-inline', type: 'button', text: String(item.label) });
        btn.addEventListener('click', () => {
            if (item.action === 'setApiKey') {
                vscode.postMessage({ type: 'setApiKey', provider: currentProvider() });
            } else if (item.action === 'setSmtpPassword') {
                vscode.postMessage({ type: 'setSmtpPassword' });
            } else if (item.action === 'checkClaudeLogin') {
                vscode.postMessage({ type: 'checkClaudeLogin' });
            }
        });
        const row = h('div', { class: 'field action' }, [
            h('div', { class: 'action-row' }, [btn, status]),
            item.help ? h('p', { class: 'help', text: String(item.help) }) : null,
        ]);
        actions.set(item.id, { row, status });
        fields.set(item.id, { item, row, get: () => undefined, error: status });
        return row;
    }

    // ─── Provider-dependent visibility & models ──────────────────

    function currentProvider() {
        const f = fields.get('ai.provider');
        return f ? String(f.get()) : '';
    }

    function applyProvider() {
        const p = currentProvider();
        for (const { item, row } of fields.values()) {
            let show = true;
            if (Array.isArray(item.showFor)) { show = item.showFor.includes(p); }
            if (Array.isArray(item.hideFor) && item.hideFor.includes(p)) { show = false; }
            row.hidden = !show;
        }
    }

    function fieldValue(id) {
        const f = fields.get(id);
        return f ? f.get() : '';
    }

    function fetchModels() {
        if (!model.hint) { return; }
        modelReq += 1;
        model.hint.textContent = 'Fetching models…';
        vscode.postMessage({
            type: 'fetchModels',
            requestId: modelReq,
            provider: currentProvider(),
            baseUrl: String(fieldValue('ai.baseUrl') || '').trim(),
            vendor: String(fieldValue('ai.vendor') || '').trim(),
        });
    }

    function onModels(msg) {
        if (msg.requestId !== modelReq || !model.select || !model.hint) { return; }
        const list = Array.isArray(msg.models) ? msg.models : [];
        const key = actions.get('action.apiKey');
        if (key) {
            key.status.textContent = msg.keyStatus === 'stored' ? '✓ Key stored' : msg.keyStatus === 'missing' ? 'No key stored' : '';
        }
        if (list.length === 0) {
            showModelMode('manual');
            model.hint.textContent = msg.detail
                ? 'Could not list models: ' + String(msg.detail) + ' Type a model name, or leave blank for the default.'
                : 'Type a model name, or leave blank for the provider default.';
            return;
        }
        const cur = model.manual && model.input ? model.input.value.trim() : model.current;
        model.select.replaceChildren(h('option', { value: '', text: '(provider default)' }));
        let found = cur === '';
        for (const m of list) {
            const label = String(m.label || m.id) + (m.detail ? ' — ' + String(m.detail) : '');
            const opt = h('option', { value: String(m.id), text: label });
            if (String(m.id) === cur) { opt.selected = true; found = true; }
            model.select.append(opt);
        }
        if (!found) {
            model.select.insertBefore(h('option', { value: cur, text: cur + ' (current, not in list)', selected: true }), model.select.children[1] || null);
        }
        model.hint.textContent = '';
        showModelMode('select');
    }

    // ─── Save ────────────────────────────────────────────────────

    function markDirty() { dirty = true; }

    function clearErrors() {
        for (const f of fields.values()) {
            if (f.item.kind !== 'action') { f.error.hidden = true; f.error.textContent = ''; }
        }
        if (formError) { formError.hidden = true; formError.textContent = ''; }
    }

    function doSave() {
        clearErrors();
        /** @type {Record<string, unknown>} */
        const values = {};
        for (const [id, f] of fields) {
            if (f.item.kind === 'action') { continue; }
            values[id] = f.get();
        }
        vscode.postMessage({ type: 'save', values });
    }

    function onSaved(msg) {
        if (msg.ok) { dirty = false; return; }
        let firstTab = null;
        for (const [id, text] of Object.entries(msg.errors || {})) {
            const f = fields.get(id);
            if (f && f.item.kind !== 'action') {
                f.error.textContent = String(text);
                f.error.hidden = false;
                f.row.hidden = false;
                if (!firstTab) { firstTab = f.item.tab; }
            } else if (formError) {
                formError.textContent = String(text);
                formError.hidden = false;
            }
        }
        if (firstTab) { selectTab(firstTab); }
    }

    function showStale() {
        if (!notice) { return; }
        notice.replaceChildren(
            document.createTextNode('Argus settings were changed elsewhere. '),
        );
        const reload = h('a', { href: '#', text: dirty ? 'Reload (discards your edits)' : 'Reload' });
        reload.addEventListener('click', (e) => { e.preventDefault(); vscode.postMessage({ type: 'ready' }); });
        notice.append(reload);
        notice.hidden = false;
        if (!dirty) { vscode.postMessage({ type: 'ready' }); }
    }

    // ─── Wiring ──────────────────────────────────────────────────

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || typeof msg.type !== 'string') { return; }
        switch (msg.type) {
            case 'init': render(msg); break;
            case 'models': onModels(msg); break;
            case 'saved': onSaved(msg); break;
            case 'stale': showStale(); break;
            case 'apiKeySet': fetchModels(); break;
            case 'actionStatus': {
                const a = actions.get(String(msg.id));
                if (a) { a.status.textContent = String(msg.status || ''); }
                break;
            }
        }
    });

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            doSave();
        }
    });

    try {
        const st = vscode.getState();
        if (st && typeof st.activeTab === 'string') { activeTab = st.activeTab; }
    } catch { /* ignore */ }
    vscode.postMessage({ type: 'ready' });
})();
