// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Field model for the Argus Settings webview.
 *
 * The panel describes *which* settings it shows and how to label them; types,
 * defaults, enums and bounds come from the extension's own `package.json`
 * schema at runtime, so the panel cannot drift from the declared
 * configuration. A field whose key is not declared is not shown and cannot be
 * written.
 *
 * Everything posted back by the webview is treated as untrusted:
 * {@link planSave} validates ids, types, enum membership, bounds and formats
 * before anything reaches `WorkspaceConfiguration.update`.
 *
 * No `vscode` import — pure logic.
 */

export type TabId = 'ai' | 'email' | 'pipeline' | 'labels' | 'security' | 'trust' | 'ratelimits';

export const TABS: readonly { id: TabId; label: string }[] = [
    { id: 'ai', label: 'AI Provider' },
    { id: 'email', label: 'Email' },
    { id: 'pipeline', label: 'Pipeline' },
    { id: 'labels', label: 'Labels' },
    { id: 'security', label: 'Security' },
    { id: 'trust', label: 'Trust & Comments' },
    { id: 'ratelimits', label: 'Rate Limits' },
];

export type FieldKind = 'string' | 'number' | 'boolean' | 'enum' | 'stringList' | 'model';

/** Subset of a JSON-schema configuration property we read. */
export interface JsonSchemaProp {
    type?: string | string[];
    default?: unknown;
    enum?: unknown[];
    enumItemLabels?: string[];
    minimum?: number;
    maximum?: number;
    description?: string;
    markdownDescription?: string;
    properties?: Record<string, JsonSchemaProp>;
}

/** Shape of `WorkspaceConfiguration.inspect()` that we use. */
export interface InspectLike {
    defaultValue?: unknown;
    globalValue?: unknown;
}

type Check = (v: string) => string | undefined;

interface FieldSpec {
    /** Config key under `argus.` */
    key: string;
    /** Path inside an object-valued setting, e.g. `['host']` for `email.smtp`. */
    sub?: string[];
    tab: TabId;
    section?: string;
    label: string;
    help?: string;
    /** Used only when the schema doesn't say (sub-fields, or `model`). */
    kind?: FieldKind;
    integer?: boolean;
    min?: number;
    max?: number;
    step?: number;
    placeholder?: string;
    maxLength?: number;
    /** Per-string check (each item for stringList). Returns an error message. */
    check?: Check;
    optionLabels?: Record<string, string>;
    /** Only shown when `ai.provider` is one of these. */
    showFor?: string[];
    /** Hidden when `ai.provider` is one of these. */
    hideFor?: string[];
}

export interface ActionView {
    id: string;
    kind: 'action';
    action: 'setApiKey' | 'setSmtpPassword' | 'checkClaudeLogin';
    tab: TabId;
    section?: string;
    label: string;
    help?: string;
    status?: string;
    showFor?: string[];
}

/** A field resolved against the schema and current values; sent to the webview. */
export interface FieldView {
    id: string;
    key: string;
    sub?: string[];
    tab: TabId;
    section?: string;
    label: string;
    help?: string;
    kind: FieldKind;
    value: unknown;
    defaultValue: unknown;
    options?: { value: string; label: string }[];
    min?: number;
    max?: number;
    step?: number;
    placeholder?: string;
    showFor?: string[];
    hideFor?: string[];
}

/** Resolved field plus server-only validation data (never posted). */
export interface ResolvedField extends FieldView {
    integer: boolean;
    maxLength: number;
    check?: Check;
}

// ─── Format checks ──────────────────────────────────────────────

const noControl: Check = (v) => {
    for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) { return 'Control characters are not allowed.'; }
    }
    return undefined;
};
const re = (rx: RegExp, msg: string): Check => (v) => (v === '' || rx.test(v) ? undefined : msg);

const checkEmail = re(/^[^\s@,;<>"'()]+@[^\s@,;<>"'()]+$/, 'Not a valid email address.');
const checkHost = re(/^[A-Za-z0-9.-]+$/, 'Host name may only contain letters, digits, dots and hyphens.');
const checkTime = re(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM.');
const checkTimezone = re(/^[A-Za-z0-9_+\-/]+$/, 'Use an IANA zone name such as UTC or Europe/London.');
const checkBranchPrefix = re(/^[A-Za-z0-9._\-/]+$/, 'Letters, digits, ".", "_", "-" and "/" only.');
const checkVendor = re(/^[A-Za-z0-9._-]+$/, 'Letters, digits, ".", "_" and "-" only.');
const checkUsername = re(/^[A-Za-z0-9._-]+$/, 'Not a valid username.');
/** Format checks shared with the repo settings panel. Empty string passes. */
export const checks = { email: (v: string) => checkEmail(v), host: (v: string) => checkHost(v), noControl: (v: string) => noControl(v) };

const checkUrl: Check = (v) => {
    if (v === '') { return undefined; }
    try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:' ? undefined : 'Must be an http(s) URL.';
    } catch {
        return 'Not a valid URL.';
    }
};

// ─── Field list ─────────────────────────────────────────────────

export const PROVIDER_LABELS: Record<string, string> = {
    'vscode-lm': 'VS Code / Copilot',
    'claude-code': 'Claude subscription (Claude Code)',
    anthropic: 'Anthropic API',
    openai: 'OpenAI',
    gemini: 'Google Gemini',
    ollama: 'Ollama (local)',
    'openai-compatible': 'OpenAI-compatible endpoint',
};

const RATE = { tab: 'ratelimits' as const, integer: true, min: 0 };

const FIELDS: FieldSpec[] = [
    // AI
    { key: 'ai.provider', tab: 'ai', label: 'Provider', optionLabels: PROVIDER_LABELS },
    { key: 'ai.model', tab: 'ai', label: 'Model', kind: 'model', maxLength: 200, check: noControl },
    {
        key: 'ai.effort', tab: 'ai', label: 'Effort', showFor: ['anthropic', 'claude-code'],
        help: 'How hard the model thinks before answering. Higher = better, slower, costlier.',
    },
    {
        key: 'ai.claudePath', tab: 'ai', label: 'Claude binary path', showFor: ['claude-code'],
        placeholder: 'auto-detect', maxLength: 4096, check: noControl,
        help: 'Optional path to the claude executable. Leave blank to auto-detect.',
    },
    {
        key: 'ai.baseUrl', tab: 'ai', label: 'Base URL', hideFor: ['vscode-lm', 'claude-code'],
        placeholder: 'provider default', maxLength: 2048, check: checkUrl,
        help: 'Leave blank for the provider’s default endpoint. Required for OpenAI-compatible.',
    },
    {
        key: 'ai.vendor', tab: 'ai', label: 'VS Code LM vendor', showFor: ['vscode-lm'],
        placeholder: 'copilot', maxLength: 100, check: checkVendor,
        help: 'Which extension provides the model. Usually "copilot".',
    },
    {
        key: 'ai.maxTokens', tab: 'ai', label: 'Max tokens', hideFor: ['vscode-lm', 'claude-code'], integer: true,
        help: 'Reply ceiling. Needs headroom — code generation returns whole files.',
    },

    // Email
    { key: 'email.enabled', tab: 'email', label: 'Enable email notifications' },
    { key: 'email.smtp', sub: ['host'], tab: 'email', section: 'SMTP server', label: 'Host', kind: 'string', placeholder: 'smtp.example.com', maxLength: 253, check: checkHost },
    { key: 'email.smtp', sub: ['port'], tab: 'email', section: 'SMTP server', label: 'Port', kind: 'number', integer: true, min: 1, max: 65535 },
    { key: 'email.smtp', sub: ['user'], tab: 'email', section: 'SMTP server', label: 'User', kind: 'string', maxLength: 320, check: noControl },
    { key: 'email.smtp', sub: ['secure'], tab: 'email', section: 'SMTP server', label: 'Use SSL (port 465)', kind: 'boolean' },
    { key: 'email.fromAddress', tab: 'email', section: 'Sender & recipients', label: 'From address', placeholder: 'argus@example.com', maxLength: 320, check: checkEmail },
    { key: 'email.fromName', tab: 'email', section: 'Sender & recipients', label: 'From name', maxLength: 100, check: noControl },
    {
        key: 'email.defaultRecipients', tab: 'email', section: 'Sender & recipients', label: 'Default recipients',
        placeholder: 'you@example.com, team@example.com', maxLength: 320, check: checkEmail,
        help: 'Comma-separated. Used when a repo has no per-repo recipients.',
    },
    { key: 'email.quietHours', sub: ['start'], tab: 'email', section: 'Quiet hours', label: 'Start', kind: 'string', placeholder: '23:00', maxLength: 5, check: checkTime },
    { key: 'email.quietHours', sub: ['end'], tab: 'email', section: 'Quiet hours', label: 'End', kind: 'string', placeholder: '07:00', maxLength: 5, check: checkTime },
    { key: 'email.quietHours', sub: ['timezone'], tab: 'email', section: 'Quiet hours', label: 'Time zone', kind: 'string', placeholder: 'UTC', maxLength: 64, check: checkTimezone },
    // Per-event toggles are expanded from the schema default at runtime (see EVENTS_KEY).

    // Pipeline
    { key: 'pollIntervalMinutes', tab: 'pipeline', label: 'Poll interval (minutes)', integer: true, min: 1 },
    { key: 'branchPrefix', tab: 'pipeline', label: 'Branch prefix', maxLength: 100, check: checkBranchPrefix },
    { key: 'maxIterations', tab: 'pipeline', label: 'Max CI iterations', integer: true, min: 1 },
    { key: 'maxDiffLines', tab: 'pipeline', label: 'Max diff lines', integer: true, min: 1 },
    { key: 'maxConcurrentIssues', tab: 'pipeline', label: 'Concurrent issues', integer: true, min: 1 },
    { key: 'watchdogTimeoutMinutes', tab: 'pipeline', label: 'Watchdog timeout (minutes)', integer: true, min: 1 },
    { key: 'dryRun', tab: 'pipeline', label: 'Dry run (log actions, write nothing)' },
    { key: 'autoStartOnActivation', tab: 'pipeline', label: 'Auto-start when VS Code launches' },
    { key: 'logLevel', tab: 'pipeline', label: 'Log level' },
    { key: 'prAnalysis.enabled', tab: 'pipeline', section: 'PR analysis', label: 'Analyze competing PRs' },
    { key: 'prAnalysis.synthesisEnabled', tab: 'pipeline', section: 'PR analysis', label: 'Post synthesis plans' },
    ...['correctness', 'completeness', 'codeQuality', 'testCoverage', 'minimalInvasiveness', 'ciPassing'].map((w): FieldSpec => ({
        key: 'prAnalysis.weights', sub: [w], tab: 'pipeline', section: 'PR analysis weights',
        label: humanize(w), kind: 'number', min: 0, max: 1, step: 0.05,
    })),

    // Labels
    { key: 'labels.approved', tab: 'labels', label: 'Approved', maxLength: 50, check: noControl },
    { key: 'labels.rejected', tab: 'labels', label: 'Rejected', maxLength: 50, check: noControl },
    { key: 'labels.needsReview', tab: 'labels', label: 'Needs review', maxLength: 50, check: noControl },
    { key: 'labels.subversionDetected', tab: 'labels', label: 'Subversion detected', maxLength: 50, check: noControl },

    // Security
    { key: 'security.threatThreshold', tab: 'security', label: 'Threat threshold', min: 0, max: 1, step: 0.05 },
    { key: 'security.blockThreshold', tab: 'security', label: 'Block threshold', min: 0, max: 1, step: 0.05 },
    { key: 'security.maxInputLength', tab: 'security', label: 'Max untrusted input length', integer: true, min: 100 },
    { key: 'security.autoBlock', tab: 'security', label: 'Automatically block users the model confirms as hostile' },
    { key: 'security.reportOnBlock', tab: 'security', label: 'Report user to the platform when blocking' },
    { key: 'security.deleteHostileComments', tab: 'security', label: 'Delete comments the model confirms as hostile' },
    { key: 'security.reEvaluateOnEdit', tab: 'security', label: 'Re-evaluate issues when the body is edited' },
    { key: 'crypto.keyRotationDays', tab: 'security', section: 'Signing keys', label: 'Key rotation (days)', integer: true, min: 1 },
    { key: 'crypto.nonceRetentionDays', tab: 'security', section: 'Signing keys', label: 'Nonce retention (days)', integer: true, min: 1 },

    // Trust & comments
    {
        key: 'trust.trustedUsers', tab: 'trust', label: 'Trusted users', placeholder: 'alice, bob',
        maxLength: 100, check: checkUsername, help: 'Comma-separated usernames.',
    },
    { key: 'trust.treatMaintainersAsTrusted', tab: 'trust', label: 'Treat maintainers as trusted' },
    { key: 'trust.treatReviewersAsTrusted', tab: 'trust', label: 'Treat reviewers as trusted' },
    { key: 'trust.newAccountSuspicionDays', tab: 'trust', label: 'New-account suspicion (days)', integer: true, min: 0 },
    { key: 'trust.historyWeight', tab: 'trust', label: 'History weight', min: 0, step: 0.1 },
    { key: 'comments.processIssueComments', tab: 'trust', section: 'Comment monitoring', label: 'Process issue comments' },
    { key: 'comments.processPRComments', tab: 'trust', section: 'Comment monitoring', label: 'Process PR comments' },
    { key: 'comments.processPRReviews', tab: 'trust', section: 'Comment monitoring', label: 'Process PR reviews' },

    // Rate limits
    { key: 'rateLimits.commentsPerHour', ...RATE, label: 'Comments / hour' },
    { key: 'rateLimits.branchesPerHour', ...RATE, label: 'Branches / hour' },
    { key: 'rateLimits.prsPerHour', ...RATE, label: 'PRs / hour' },
    { key: 'rateLimits.pushesPerHour', ...RATE, label: 'Pushes / hour' },
    { key: 'rateLimits.llmCallsPerHour', ...RATE, label: 'LLM calls / hour' },
    { key: 'rateLimits.issuesPerHour', ...RATE, label: 'Issues / hour' },
    { key: 'rateLimits.blocksPerDay', ...RATE, label: 'Blocks / day' },
    { key: 'rateLimits.queueDepth', ...RATE, label: 'Queue depth' },
];

const EVENTS_KEY = 'email.events';
const MAX_LIST_ITEMS = 200;

// ─── Resolution ─────────────────────────────────────────────────

export function fieldId(key: string, sub?: string[]): string {
    return sub && sub.length ? `${key}/${sub.join('/')}` : key;
}

/**
 * Resolve the field list against the declared schema and current values.
 *
 * @param schema   `contributes.configuration` properties, keyed `argus.*`
 *                 (empty if the package JSON couldn't be read)
 * @param inspect  `getConfiguration('argus').inspect(key)`
 */
export function resolveFields(
    schema: Record<string, JsonSchemaProp>,
    inspect: (key: string) => InspectLike | undefined,
): ResolvedField[] {
    const haveSchema = Object.keys(schema).length > 0;
    const specs = [...FIELDS, ...eventSpecs(schema, inspect)];
    const out: ResolvedField[] = [];

    for (const spec of specs) {
        const prop = schema[`argus.${spec.key}`];
        const info = inspect(spec.key);
        // Undeclared settings can't be written — don't offer them.
        if (haveSchema ? !prop : info?.defaultValue === undefined) { continue; }

        const subProp = spec.sub ? prop?.properties?.[spec.sub[0]] : prop;
        const kind = resolveKind(spec, spec.sub ? subProp : prop);
        if (!kind) { continue; }

        const topDefault = info?.defaultValue ?? prop?.default;
        const topValue = info?.globalValue ?? topDefault;
        let value: unknown;
        let defaultValue: unknown;
        if (spec.sub) {
            defaultValue = getPath(topDefault, spec.sub) ?? (spec.sub.length === 1 ? subProp?.default : undefined);
            value = getPath(topValue, spec.sub) ?? defaultValue;
        } else {
            defaultValue = topDefault;
            value = topValue;
        }

        const enumValues = (spec.sub ? subProp : prop)?.enum;
        const options = kind === 'enum' && Array.isArray(enumValues)
            ? enumValues.filter((v): v is string => typeof v === 'string').map((v, i) => ({
                value: v,
                label: spec.optionLabels?.[v] ?? (spec.sub ? subProp : prop)?.enumItemLabels?.[i] ?? v,
            }))
            : undefined;

        const typeIsInteger = typeIncludes((spec.sub ? subProp : prop)?.type, 'integer');
        out.push({
            id: fieldId(spec.key, spec.sub),
            key: spec.key,
            sub: spec.sub,
            tab: spec.tab,
            section: spec.section,
            label: spec.label,
            help: spec.help ?? plainText((spec.sub ? subProp : prop)?.description ?? (spec.sub ? subProp : prop)?.markdownDescription),
            kind,
            value: coerceDisplay(kind, value),
            defaultValue,
            options,
            min: (spec.sub ? subProp : prop)?.minimum ?? spec.min,
            max: (spec.sub ? subProp : prop)?.maximum ?? spec.max,
            step: spec.step ?? (spec.integer || typeIsInteger ? 1 : undefined),
            placeholder: spec.placeholder,
            showFor: spec.showFor,
            hideFor: spec.hideFor,
            integer: !!spec.integer || typeIsInteger,
            maxLength: spec.maxLength ?? 1024,
            check: spec.check ?? (kind === 'string' || kind === 'stringList' ? noControl : undefined),
        });
    }
    return out;
}

/** Strip server-only data before posting to the webview. */
export function toView(f: ResolvedField): FieldView {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { integer, maxLength, check, ...view } = f;
    return view;
}

function eventSpecs(schema: Record<string, JsonSchemaProp>, inspect: (key: string) => InspectLike | undefined): FieldSpec[] {
    const info = inspect(EVENTS_KEY);
    const def = info?.defaultValue ?? schema[`argus.${EVENTS_KEY}`]?.default;
    const names = new Set<string>();
    for (const src of [def, info?.globalValue]) {
        if (isRecord(src)) {
            for (const [name, v] of Object.entries(src)) {
                if (isRecord(v) && /^[A-Za-z0-9_]{1,64}$/.test(name)) { names.add(name); }
            }
        }
    }
    return [...names].map((name) => ({
        key: EVENTS_KEY, sub: [name, 'enabled'], tab: 'email' as const, section: 'Events', label: humanize(name), kind: 'boolean' as const,
    }));
}

function resolveKind(spec: FieldSpec, prop: JsonSchemaProp | undefined): FieldKind | undefined {
    if (spec.kind === 'model') { return 'model'; }
    const t = prop?.type;
    if (typeIncludes(t, 'boolean')) { return 'boolean'; }
    if (typeIncludes(t, 'number') || typeIncludes(t, 'integer')) { return 'number'; }
    if (typeIncludes(t, 'array')) { return 'stringList'; }
    if (typeIncludes(t, 'string')) { return Array.isArray(prop?.enum) ? 'enum' : 'string'; }
    if (t === undefined) { return spec.kind; }
    return undefined; // object etc. without a sub-path: not editable here
}

function typeIncludes(t: string | string[] | undefined, name: string): boolean {
    return Array.isArray(t) ? t.includes(name) : t === name;
}

function coerceDisplay(kind: FieldKind, v: unknown): unknown {
    switch (kind) {
        case 'boolean': return v === true;
        case 'number': return typeof v === 'number' && Number.isFinite(v) ? v : null;
        case 'stringList': return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
        default: return typeof v === 'string' ? v : '';
    }
}

// ─── Save planning ──────────────────────────────────────────────

export interface SavePlan {
    /** Field id → message. `_form` for problems with the message itself. */
    errors: Record<string, string>;
    /** `undefined` value = remove the user setting (back to default). */
    updates: { key: string; value: unknown }[];
}

/**
 * Validate a `values` object from the webview and compute config updates.
 *
 * All-or-nothing: if anything is invalid, `updates` is empty. Values equal to
 * the default are written as `undefined` so settings.json doesn't pin
 * defaults; unchanged values aren't written at all.
 */
export function planSave(
    rawValues: unknown,
    fields: readonly ResolvedField[],
    inspect: (key: string) => InspectLike | undefined,
): SavePlan {
    const errors: Record<string, string> = {};
    if (!isRecord(rawValues)) {
        return { errors: { _form: 'Malformed save request.' }, updates: [] };
    }
    const byId = new Map(fields.map((f) => [f.id, f]));
    const accepted: { field: ResolvedField; value: unknown }[] = [];

    for (const [id, raw] of Object.entries(rawValues)) {
        const field = byId.get(id);
        if (!field) {
            errors._form = `Unknown setting "${id.slice(0, 80)}".`;
            continue;
        }
        const r = validateValue(field, raw);
        if (r.error) { errors[id] = r.error; } else { accepted.push({ field, value: r.value }); }
    }
    if (Object.keys(errors).length) { return { errors, updates: [] }; }

    // Group by config key; sub-fields merge into a copy of the current object.
    const pending = new Map<string, { value: unknown; isObject: boolean }>();
    for (const { field, value } of accepted) {
        const info = inspect(field.key);
        if (!field.sub) {
            pending.set(field.key, { value, isObject: false });
            continue;
        }
        let entry = pending.get(field.key);
        if (!entry) {
            const base = info?.globalValue ?? info?.defaultValue ?? {};
            entry = { value: isRecord(base) ? structuredClone(base) : {}, isObject: true };
            pending.set(field.key, entry);
        }
        const obj = entry.value as Record<string, unknown>;
        // Don't materialize sub-values the user didn't touch.
        if (getPath(obj, field.sub) === undefined && (value === null || deepEqual(value, field.value))) { continue; }
        if (value === null) { deletePath(obj, field.sub); } else { setPath(obj, field.sub, value); }
    }

    const updates: SavePlan['updates'] = [];
    for (const [key, { value }] of pending) {
        const info = inspect(key);
        const def = info?.defaultValue;
        let target: unknown = value === null ? undefined : value;
        if (target !== undefined && deepEqual(target, def)) { target = undefined; }
        if (deepEqual(target, info?.globalValue)) { continue; }
        updates.push({ key, value: target });
    }
    return { errors, updates };
}

/** Validate one untrusted value against a resolved field. */
export function validateValue(f: ResolvedField, raw: unknown): { value?: unknown; error?: string } {
    switch (f.kind) {
        case 'boolean':
            return typeof raw === 'boolean' ? { value: raw } : { error: 'Expected true/false.' };

        case 'number': {
            if (raw === null) { return { value: null }; }
            if (typeof raw !== 'number' || !Number.isFinite(raw)) { return { error: 'Expected a number.' }; }
            if (f.integer && !Number.isInteger(raw)) { return { error: 'Expected a whole number.' }; }
            if (f.min !== undefined && raw < f.min) { return { error: `Must be at least ${f.min}.` }; }
            if (f.max !== undefined && raw > f.max) { return { error: `Must be at most ${f.max}.` }; }
            return { value: raw };
        }

        case 'enum':
            return typeof raw === 'string' && f.options?.some((o) => o.value === raw)
                ? { value: raw }
                : { error: 'Not one of the allowed values.' };

        case 'string':
        case 'model': {
            if (typeof raw !== 'string') { return { error: 'Expected text.' }; }
            const v = raw.trim();
            if (v.length > f.maxLength) { return { error: `At most ${f.maxLength} characters.` }; }
            const e = (f.check ?? noControl)(v);
            return e ? { error: e } : { value: v };
        }

        case 'stringList': {
            if (!Array.isArray(raw)) { return { error: 'Expected a list.' }; }
            if (raw.length > MAX_LIST_ITEMS) { return { error: `At most ${MAX_LIST_ITEMS} entries.` }; }
            const out: string[] = [];
            for (const item of raw) {
                if (typeof item !== 'string') { return { error: 'Expected a list of text values.' }; }
                const v = item.trim();
                if (!v) { continue; }
                if (v.length > f.maxLength) { return { error: `Entries are limited to ${f.maxLength} characters.` }; }
                const e = (f.check ?? noControl)(v);
                if (e) { return { error: `${v.slice(0, 60)}: ${e}` }; }
                if (!out.includes(v)) { out.push(v); }
            }
            return { value: out };
        }
    }
}

// ─── Helpers ────────────────────────────────────────────────────

export function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function getPath(obj: unknown, path: string[]): unknown {
    let cur = obj;
    for (const p of path) {
        if (!isRecord(cur) || !Object.prototype.hasOwnProperty.call(cur, p)) { return undefined; }
        cur = cur[p];
    }
    return cur;
}

function setPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
    let cur = obj;
    for (let i = 0; i < path.length - 1; i++) {
        if (UNSAFE_KEYS.has(path[i])) { return; }
        const next = cur[path[i]];
        if (!isRecord(next)) { cur[path[i]] = {}; }
        cur = cur[path[i]] as Record<string, unknown>;
    }
    const last = path[path.length - 1];
    if (!UNSAFE_KEYS.has(last)) { cur[last] = value; }
}

function deletePath(obj: Record<string, unknown>, path: string[]): void {
    const parent = getPath(obj, path.slice(0, -1));
    if (isRecord(parent)) { delete parent[path[path.length - 1]]; }
}

export function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) { return true; }
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
    }
    if (isRecord(a) && isRecord(b)) {
        const ka = Object.keys(a);
        const kb = Object.keys(b);
        return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
    }
    return false;
}

function humanize(name: string): string {
    const s = name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/\bci\b/g, 'CI').replace(/\bpr\b/g, 'PR');
}

/** Rough markdown → plain text for help lines (rendered with textContent). */
function plainText(md: string | undefined): string | undefined {
    if (!md) { return undefined; }
    return md
        .replace(/```[\s\S]*?```/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*`]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300) || undefined;
}
