// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * GitLab forge implementation over the REST API v4 (plain fetch).
 *
 * Note ids returned by this forge are `issue:<iid>:<noteId>` or `mr:<iid>:<noteId>`
 * because GitLab's delete endpoint needs the noteable; `deleteComment` parses them.
 *
 * Issues and merge requests have separate iid spaces: `addLabel`/`removeLabel`/
 * `addComment`/`updateIssue` act on issues only.
 */

import type {
    Forge,
    ForgePlatform,
    Issue,
    Comment,
    ReviewComment,
    PullRequest,
    FileChange,
    CheckRun,
    CommitStatus,
    CodeSearchResult,
    CommitFile,
    RepoRole,
    UserHistory,
    RepoKey,
    TreeEntry,
    TokenValidation,
} from './types';
import { repoKey, MAX_LIST_ITEMS } from './types';
import { ForgeHttpError, UnsupportedError, httpStatus } from './errors';
import { referencesIssue, isIssueBranch, hasDraftTitle, countDiffLines } from './util';

const PER_PAGE = 100;
/** GitLab rejects commit-status descriptions over 255 chars. */
const STATUS_DESCRIPTION_MAX = 255;
/** Tail of each failed job's trace returned by getCheckRunLog. */
const LOG_TAIL_CHARS = 10_000;

type NoteableKind = 'issue' | 'mr';

// GitLab responses are loosely typed JSON.
/* eslint-disable @typescript-eslint/no-explicit-any */

export class GitLabForge implements Forge {
    readonly platform: ForgePlatform = 'gitlab';
    private readonly baseUrl: string;
    private readonly projectPath: string;
    private defaultBranchCache: string | null = null;
    private readonly userIdCache = new Map<string, number | null>();

    /**
     * @param baseUrl Instance root, e.g. `https://gitlab.example.com` (API is `/api/v4` below it).
     */
    constructor(
        readonly owner: string,
        readonly repo: string,
        private readonly token: string,
        baseUrl: string = 'https://gitlab.com',
    ) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        // Full path (incl. subgroups) URL-encoded is a valid project id.
        this.projectPath = encodeURIComponent(`${owner}/${repo}`);
    }

    get key(): RepoKey {
        return repoKey({ forge: 'gitlab', owner: this.owner, repo: this.repo, pollIntervalMinutes: 0 });
    }

    private get project(): string {
        return `/projects/${this.projectPath}`;
    }

    /** Raw request; throws ForgeHttpError on non-2xx. */
    private async request(path: string, options: RequestInit = {}): Promise<Response> {
        const url = `${this.baseUrl}/api/v4${path}`;
        let response: Response;
        try {
            response = await fetch(url, {
                ...options,
                headers: {
                    'PRIVATE-TOKEN': this.token,
                    ...(options.body !== undefined && { 'Content-Type': 'application/json' }),
                    ...options.headers,
                },
            });
        } catch (err) {
            throw new ForgeHttpError(0, `GitLab request failed for ${redactQuery(path)}: ${err instanceof Error ? err.message : err}`);
        }
        if (!response.ok) {
            let detail = '';
            try {
                const text = await response.text();
                try {
                    const j = JSON.parse(text);
                    detail = typeof j?.message === 'string' ? j.message : JSON.stringify(j?.message ?? j?.error ?? '');
                } catch { detail = text; }
            } catch { /* no body */ }
            const retryAfter = Number(response.headers.get('retry-after') ?? NaN);
            throw new ForgeHttpError(
                response.status,
                `GitLab API error: ${response.status} ${response.statusText} for ${redactQuery(path)}${detail ? ` — ${detail.slice(0, 300)}` : ''}`,
                Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
            );
        }
        return response;
    }

    /** JSON request. Empty bodies (204) resolve to undefined. */
    private async api<T>(path: string, options: RequestInit = {}): Promise<T> {
        const response = await this.request(path, options);
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
    }

    /** Offset pagination up to `maxItems`. `path` may already carry a query string. */
    private async paginate<T = any>(path: string, maxItems = MAX_LIST_ITEMS): Promise<T[]> {
        const out: T[] = [];
        const sep = path.includes('?') ? '&' : '?';
        for (let page = 1; out.length < maxItems; page++) {
            const response = await this.request(`${path}${sep}per_page=${PER_PAGE}&page=${page}`);
            const data = (await response.json()) as T[];
            out.push(...data);
            const next = response.headers.get('x-next-page');
            // x-next-page is "" on the last page; fall back to a short page when absent.
            if (next !== null ? next === '' : data.length < PER_PAGE) { break; }
        }
        return out.slice(0, maxItems);
    }

    /** Value of `x-total` for a filtered list, fetching one item. */
    private async countOf(path: string): Promise<number> {
        const sep = path.includes('?') ? '&' : '?';
        const response = await this.request(`${path}${sep}per_page=1`);
        const header = response.headers.get('x-total');
        const total = header ? Number(header) : NaN;
        if (Number.isFinite(total)) { return total; }
        // x-total is omitted for very large result sets; report what we can see.
        return ((await response.json()) as unknown[]).length;
    }

    private async lookupUserId(username: string): Promise<number | null> {
        if (this.userIdCache.has(username)) { return this.userIdCache.get(username)!; }
        const users = await this.api<any[]>(`/users?username=${encodeURIComponent(username)}`);
        const id = users.length > 0 ? Number(users[0].id) : null;
        this.userIdCache.set(username, id);
        return id;
    }

    // ─── Issues ─────────────────────────────────────────────────────

    async listNewIssues(since: Date): Promise<Issue[]> {
        // Created-or-updated since, matching GitHub's `since` semantics.
        const params = new URLSearchParams({
            state: 'opened',
            updated_after: since.toISOString(),
            order_by: 'updated_at',
            sort: 'asc',
        });
        const data = await this.paginate(`${this.project}/issues?${params}`);
        return data.map((i) => this.mapIssue(i));
    }

    async getIssue(issueNumber: number): Promise<Issue> {
        const data = await this.api<any>(`${this.project}/issues/${issueNumber}`);
        return this.mapIssue(data);
    }

    async getIssueComments(issueNumber: number): Promise<Comment[]> {
        return this.listNotes('issue', issueNumber);
    }

    async getCommentsSince(issueNumber: number, since: Date): Promise<Comment[]> {
        return this.listNotes('issue', issueNumber, since);
    }

    /** Non-system notes, oldest first. With `since`, only notes updated at/after it. */
    private async listNotes(kind: NoteableKind, iid: number, since?: Date): Promise<Comment[]> {
        const base = `${this.project}/${kind === 'issue' ? 'issues' : 'merge_requests'}/${iid}/notes`;
        let notes: any[];
        if (since) {
            // Newest-updated first so we can stop paging once past `since`.
            notes = [];
            for (let page = 1; notes.length < MAX_LIST_ITEMS; page++) {
                const data = await this.api<any[]>(`${base}?order_by=updated_at&sort=desc&per_page=${PER_PAGE}&page=${page}`);
                const fresh = data.filter((n) => new Date(n.updated_at) >= since);
                notes.push(...fresh);
                if (fresh.length < data.length || data.length < PER_PAGE) { break; }
            }
            notes.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
        } else {
            notes = await this.paginate(`${base}?order_by=created_at&sort=asc`);
        }
        return notes.filter((n) => !n.system).map((n) => this.mapComment(n, iid, kind));
    }

    async addLabel(issueNumber: number, label: string): Promise<void> {
        // add_labels is atomic server-side (no read-modify-write race).
        await this.api(`${this.project}/issues/${issueNumber}`, {
            method: 'PUT',
            body: JSON.stringify({ add_labels: label }),
        });
    }

    async removeLabel(issueNumber: number, label: string): Promise<void> {
        await this.api(`${this.project}/issues/${issueNumber}`, {
            method: 'PUT',
            body: JSON.stringify({ remove_labels: label }),
        });
    }

    async addComment(issueNumber: number, body: string): Promise<Comment> {
        const data = await this.api<any>(`${this.project}/issues/${issueNumber}/notes`, {
            method: 'POST',
            body: JSON.stringify({ body }),
        });
        return this.mapComment(data, issueNumber, 'issue');
    }

    async updateIssue(issueNumber: number, updates: { title?: string; body?: string }): Promise<void> {
        const payload: Record<string, string> = {};
        if (updates.title !== undefined) { payload.title = updates.title; }
        if (updates.body !== undefined) { payload.description = updates.body; }
        if (Object.keys(payload).length === 0) { return; }
        await this.api(`${this.project}/issues/${issueNumber}`, {
            method: 'PUT',
            body: JSON.stringify(payload),
        });
    }

    async listRepoLabels(): Promise<string[]> {
        const data = await this.paginate(`${this.project}/labels`);
        return data.map((l) => l.name);
    }

    // ─── Pull Requests (Merge Requests in GitLab) ───────────────────

    async listOpenPRs(): Promise<PullRequest[]> {
        const data = await this.paginate(`${this.project}/merge_requests?state=opened`);
        return data.map((mr) => this.mapMR(mr));
    }

    async listPRsForIssue(issueNumber: number): Promise<PullRequest[]> {
        const prs = await this.listOpenPRs();
        return prs.filter((pr) =>
            referencesIssue(pr.title, issueNumber)
            || referencesIssue(pr.body, issueNumber)
            || isIssueBranch(pr.head, issueNumber));
    }

    async getPullRequest(prNumber: number): Promise<PullRequest> {
        const data = await this.api<any>(`${this.project}/merge_requests/${prNumber}`);
        return this.mapMR(data);
    }

    async getPRComments(prNumber: number): Promise<Comment[]> {
        return this.listNotes('mr', prNumber);
    }

    async getPRReviewComments(prNumber: number): Promise<ReviewComment[]> {
        // Inline MR comments live in discussions; the first note is the thread root.
        const data = await this.paginate(`${this.project}/merge_requests/${prNumber}/discussions`);
        const result: ReviewComment[] = [];
        for (const discussion of data) {
            const notes: any[] = discussion.notes || [];
            const rootId = notes[0] ? this.noteId('mr', prNumber, notes[0].id) : undefined;
            for (const note of notes) {
                if (note.position && !note.system) {
                    const mapped = this.mapGitLabReviewComment(note, prNumber);
                    if (rootId && mapped.id !== rootId) { mapped.inReplyToId = rootId; }
                    result.push(mapped);
                }
            }
        }
        return result;
    }

    async getPRFiles(prNumber: number): Promise<FileChange[]> {
        let changes: any[];
        try {
            // /diffs is paginated (GitLab 15.7+).
            changes = await this.paginate(`${this.project}/merge_requests/${prNumber}/diffs`);
        } catch (err) {
            if (httpStatus(err) !== 404) { throw err; }
            // Older GitLab: deprecated /changes (unpaginated).
            const data = await this.api<any>(`${this.project}/merge_requests/${prNumber}/changes?access_raw_diffs=true`);
            changes = data?.changes || [];
        }
        return changes.map((c) => ({
            path: c.new_path || c.old_path,
            status: c.new_file ? 'added' as const : c.deleted_file ? 'removed' as const : c.renamed_file ? 'renamed' as const : 'modified' as const,
            ...countDiffLines(c.diff),
            patch: c.diff,
        }));
    }

    async createPullRequest(head: string, base: string, title: string, body: string): Promise<PullRequest> {
        const data = await this.api<any>(`${this.project}/merge_requests`, {
            method: 'POST',
            body: JSON.stringify({
                source_branch: head,
                target_branch: base,
                title,
                description: body,
            }),
        });
        return this.mapMR(data);
    }

    async addPRComment(prNumber: number, body: string): Promise<Comment> {
        const data = await this.api<any>(
            `${this.project}/merge_requests/${prNumber}/notes`,
            { method: 'POST', body: JSON.stringify({ body }) },
        );
        return this.mapComment(data, prNumber, 'mr');
    }

    async updatePRBody(prNumber: number, body: string): Promise<void> {
        await this.api(`${this.project}/merge_requests/${prNumber}`, {
            method: 'PUT',
            body: JSON.stringify({ description: body }),
        });
    }

    // ─── Branches & Files ───────────────────────────────────────────

    async getDefaultBranch(): Promise<string> {
        if (this.defaultBranchCache) { return this.defaultBranchCache; }
        const data = await this.api<any>(this.project);
        this.defaultBranchCache = data.default_branch;
        return data.default_branch;
    }

    async createBranch(baseBranch: string, newBranch: string): Promise<void> {
        await this.api(`${this.project}/repository/branches`, {
            method: 'POST',
            body: JSON.stringify({ branch: newBranch, ref: baseBranch }),
        });
    }

    async branchExists(branch: string): Promise<boolean> {
        try {
            await this.api(`${this.project}/repository/branches/${encodeURIComponent(branch)}`);
            return true;
        } catch (err) {
            if (httpStatus(err) === 404) { return false; }
            throw err;
        }
    }

    async getFileContent(branch: string, path: string): Promise<string> {
        const data = await this.api<any>(
            `${this.project}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`,
        );
        return Buffer.from(data.content, 'base64').toString('utf-8');
    }

    async createOrUpdateFile(branch: string, path: string, content: string, message: string): Promise<void> {
        await this.commitFiles(branch, [{ path, content }], message);
    }

    async commitFiles(branch: string, files: CommitFile[], message: string): Promise<string> {
        const actions: Record<string, string>[] = [];
        for (const f of files) {
            const exists = await this.fileExists(branch, f.path);
            if (f.content === null) {
                if (exists) { actions.push({ action: 'delete', file_path: f.path }); }
            } else {
                actions.push({ action: exists ? 'update' : 'create', file_path: f.path, content: f.content });
            }
        }
        if (actions.length === 0) {
            const b = await this.api<any>(`${this.project}/repository/branches/${encodeURIComponent(branch)}`);
            return b.commit.id;
        }
        const commit = await this.api<any>(`${this.project}/repository/commits`, {
            method: 'POST',
            body: JSON.stringify({ branch, commit_message: message, actions }),
        });
        return commit.id;
    }

    private async fileExists(branch: string, path: string): Promise<boolean> {
        try {
            await this.request(
                `${this.project}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`,
                { method: 'HEAD' },
            );
            return true;
        } catch (err) {
            if (httpStatus(err) === 404) { return false; }
            throw err;
        }
    }

    async listTree(branch: string, path: string = '', recursive: boolean = false): Promise<TreeEntry[]> {
        const params = new URLSearchParams({ ref: branch });
        if (path) { params.set('path', path); }
        if (recursive) { params.set('recursive', 'true'); }
        const data = await this.paginate(`${this.project}/repository/tree?${params}`);
        return data.map((item) => ({
            path: item.path,
            type: item.type === 'tree' ? 'tree' as const : 'blob' as const,
        }));
    }

    // ─── CI ─────────────────────────────────────────────────────────

    async createCommitStatus(
        ref: string,
        state: CommitStatus['state'],
        context: string,
        description: string,
        targetUrl?: string,
    ): Promise<void> {
        // GitLab has no 'failure'/'error' — both are 'failed'.
        const gitlabState = state === 'failure' || state === 'error' ? 'failed' : state;
        const desc = description.length > STATUS_DESCRIPTION_MAX
            ? description.slice(0, STATUS_DESCRIPTION_MAX - 1) + '…'
            : description;
        await this.api(`${this.project}/statuses/${encodeURIComponent(ref)}`, {
            method: 'POST',
            body: JSON.stringify({
                state: gitlabState,
                name: context,
                description: desc,
                ...(targetUrl && { target_url: targetUrl }),
            }),
        });
    }

    async getCommitStatuses(ref: string): Promise<CommitStatus[]> {
        const data = await this.paginate(`${this.project}/repository/commits/${encodeURIComponent(ref)}/statuses`);
        return data.map((s) => ({
            state: mapStatusState(s.status),
            context: s.name,
            description: s.description || '',
            url: s.target_url || '',
        }));
    }

    async getCheckRuns(ref: string): Promise<CheckRun[]> {
        // GitLab pipelines stand in for check runs. Keep the newest pipeline per ref
        // (branch vs. MR ref) so a superseded failed run doesn't mask a retry.
        const filter = /^[0-9a-f]{40}$/i.test(ref) ? `sha=${ref}` : `ref=${encodeURIComponent(ref)}`;
        const data = await this.paginate(`${this.project}/pipelines?${filter}&order_by=id&sort=desc`, PER_PAGE);
        const latest = new Map<string, any>();
        for (const p of data) {
            if (!latest.has(p.ref)) { latest.set(p.ref, p); }
        }
        return [...latest.values()].map((p) => ({
            id: p.id.toString(),
            name: `Pipeline #${p.id}${p.source ? ` (${p.source})` : ''}`,
            ...mapPipelineStatus(p.status),
            url: p.web_url || '',
            startedAt: p.started_at ? new Date(p.started_at) : undefined,
            completedAt: p.finished_at ? new Date(p.finished_at) : undefined,
        }));
    }

    async getCheckRunLog(checkRunId: string): Promise<string> {
        try {
            const jobs = await this.paginate(`${this.project}/pipelines/${encodeURIComponent(checkRunId)}/jobs?scope[]=failed`, PER_PAGE);
            const logs: string[] = [];
            for (const job of jobs.slice(0, 3)) {
                try {
                    // Traces are plain text, not JSON.
                    const response = await this.request(`${this.project}/jobs/${job.id}/trace`);
                    const trace = await response.text();
                    logs.push(`=== ${job.name} ===\n${trace.slice(-LOG_TAIL_CHARS)}`);
                } catch (err) {
                    logs.push(`=== ${job.name} ===\n(trace unavailable: ${httpStatus(err) ?? 'error'})`);
                }
            }
            return logs.join('\n\n') || 'No failure logs available';
        } catch (err) {
            return `Unable to retrieve pipeline log (${httpStatus(err) ?? 'error'})`;
        }
    }

    // ─── Code Search ────────────────────────────────────────────────

    async searchCode(query: string): Promise<CodeSearchResult[]> {
        const data = await this.api<any[]>(
            `${this.project}/search?scope=blobs&search=${encodeURIComponent(query)}&per_page=20`,
        );
        return data.map((item) => ({
            path: item.path || item.filename,
            matchedLines: [{ lineNumber: item.startline || 0, text: item.data || '' }],
            url: `${this.baseUrl}/${this.owner}/${this.repo}/-/blob/${encodeURIComponent(item.ref)}/${encodePath(item.path || item.filename)}`,
        }));
    }

    // ─── Users ──────────────────────────────────────────────────────

    async getUserRole(username: string): Promise<RepoRole> {
        try {
            const userId = await this.lookupUserId(username);
            if (userId === null) { return 'none'; }
            // members/all includes inherited (group) membership.
            const member = await this.api<any>(`${this.project}/members/all/${userId}`);
            const level = Number(member?.access_level ?? 0);
            if (level >= 50) { return 'owner'; }
            if (level >= 40) { return 'maintainer'; }
            if (level >= 30) { return 'write'; }   // Developer
            if (level >= 20) { return 'triage'; }  // Reporter
            if (level >= 10) { return 'read'; }    // Guest
            return 'none';
        } catch {
            return 'none'; // not a member, or lookup failed: fail closed
        }
    }

    /**
     * Counts from list `x-total` headers. previousFlags/previousBlocks/totalComments
     * are always 0 here — TrustManager overlays Argus's persisted history.
     * GitLab doesn't distinguish "closed as completed", so all closed issues count.
     */
    async getUserHistory(username: string): Promise<UserHistory> {
        let incomplete = false;
        const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
            try { return await fn(); } catch { incomplete = true; return fallback; }
        };
        const u = encodeURIComponent(username);
        const mergedPRs = await safe(() => this.countOf(`${this.project}/merge_requests?state=merged&author_username=${u}`), 0);
        const closedIssuesAsValid = await safe(() => this.countOf(`${this.project}/issues?state=closed&author_username=${u}`), 0);
        const accountCreatedAt = await safe(async () => {
            const id = await this.lookupUserId(username);
            if (id === null) { return undefined; }
            const user = await this.api<any>(`/users/${id}`);
            return user?.created_at ? new Date(user.created_at) : undefined;
        }, undefined);
        return {
            mergedPRs,
            closedIssuesAsValid,
            previousFlags: 0,
            previousBlocks: 0,
            totalComments: 0,
            accountCreatedAt,
            ...(incomplete ? { incomplete: true } : {}),
        };
    }

    // ─── Moderation ─────────────────────────────────────────────────

    async deleteComment(commentId: string): Promise<void> {
        const m = /^(issue|mr):(\d+):(\d+)$/.exec(commentId);
        if (!m) {
            throw new Error(`Invalid GitLab note id "${commentId}" (expected issue:<iid>:<id> or mr:<iid>:<id>)`);
        }
        const collection = m[1] === 'issue' ? 'issues' : 'merge_requests';
        await this.api(`${this.project}/${collection}/${m[2]}/notes/${m[3]}`, { method: 'DELETE' });
    }

    async blockUser(_username: string): Promise<void> {
        // The only GitLab block API is instance-wide and admin-only; never use it.
        throw new UnsupportedError('blockUser', 'GitLab has no project-scoped user block');
    }

    async unblockUser(_username: string): Promise<void> {
        throw new UnsupportedError('unblockUser', 'GitLab has no project-scoped user block');
    }

    async reportUser(_username: string, _reason: string): Promise<void> {
        throw new UnsupportedError('reportUser', 'GitLab has no API for reporting users');
    }

    // ─── Token Validation ───────────────────────────────────────────

    async validateTokenScopes(): Promise<TokenValidation> {
        const warnings: string[] = [];
        const errors: string[] = [];

        try {
            const data = await this.api<any>('/personal_access_tokens/self');
            const scopes: string[] = data.scopes || [];
            for (const scope of ['sudo', 'admin_mode']) {
                if (scopes.includes(scope)) {
                    errors.push(`Token has '${scope}' scope which Argus should not have.`);
                }
            }
            if (!scopes.includes('api')) {
                warnings.push(scopes.includes('read_api')
                    ? "Token has only 'read_api': Argus can read but not comment, push, or open merge requests."
                    : "Token lacks the 'api' scope; most Argus operations will fail.");
            }
            if (data.active === false || data.revoked) {
                errors.push('Token is revoked or inactive.');
            }
            if (data.expires_at) {
                const days = (Date.parse(data.expires_at) - Date.now()) / 86_400_000;
                if (days < 7) { warnings.push(`Token expires ${data.expires_at}.`); }
            }
        } catch (err) {
            const status = httpStatus(err);
            if (status === 401) {
                return { valid: false, warnings, errors: ['Token is invalid or expired.'] };
            }
            warnings.push(`Could not read token scopes (${status ?? 'network error'}); older GitLab versions lack this endpoint.`);
        }

        try {
            const project = await this.api<any>(this.project);
            const level = Math.max(
                Number(project?.permissions?.project_access?.access_level ?? 0),
                Number(project?.permissions?.group_access?.access_level ?? 0),
            );
            if (level > 0 && level < 30) {
                warnings.push('Token user has below Developer access: Argus cannot push branches or open merge requests.');
            }
            if (level >= 50) {
                warnings.push('Token user is a project Owner; Developer or Maintainer is enough for Argus.');
            }
        } catch (err) {
            const status = httpStatus(err);
            errors.push(status === 404
                ? `Project ${this.owner}/${this.repo} not found or not visible to this token.`
                : `Could not access project ${this.owner}/${this.repo} (${status ?? 'network error'}).`);
        }

        return { valid: errors.length === 0, warnings, errors };
    }

    // ─── Private Mappers ────────────────────────────────────────────

    private noteId(kind: NoteableKind, iid: number, noteId: number | string): string {
        return `${kind}:${iid}:${noteId}`;
    }

    private noteUrl(kind: NoteableKind, iid: number, noteId: number | string): string {
        const collection = kind === 'issue' ? 'issues' : 'merge_requests';
        return `${this.baseUrl}/${this.owner}/${this.repo}/-/${collection}/${iid}#note_${noteId}`;
    }

    private mapIssue(data: any): Issue {
        return {
            id: data.id.toString(),
            number: data.iid,
            title: data.title,
            body: data.description || '',
            author: data.author?.username || 'unknown',
            authorAssociation: 'NONE',
            state: data.state === 'opened' ? 'open' : 'closed',
            labels: data.labels || [],
            url: data.web_url,
            apiUrl: `${this.baseUrl}/api/v4${this.project}/issues/${data.iid}`,
            createdAt: new Date(data.created_at),
            updatedAt: new Date(data.updated_at),
            repo: this.key,
        };
    }

    private mapComment(data: any, iid: number, kind: NoteableKind): Comment {
        return {
            id: this.noteId(kind, iid, data.id),
            body: data.body || '',
            author: data.author?.username || 'unknown',
            authorAssociation: 'NONE',
            url: this.noteUrl(kind, iid, data.id),
            createdAt: new Date(data.created_at),
            updatedAt: new Date(data.updated_at ?? data.created_at),
            issueNumber: iid,
        };
    }

    private mapGitLabReviewComment(note: any, prNumber: number): ReviewComment {
        const pos = note.position || {};
        return {
            id: this.noteId('mr', prNumber, note.id),
            body: note.body || '',
            author: note.author?.username || 'unknown',
            authorAssociation: 'NONE',
            url: this.noteUrl('mr', prNumber, note.id),
            createdAt: new Date(note.created_at),
            updatedAt: new Date(note.updated_at ?? note.created_at),
            prNumber,
            path: pos.new_path || pos.old_path || '',
            line: pos.new_line ?? pos.old_line ?? null,
            side: pos.old_line && !pos.new_line ? 'LEFT' : 'RIGHT',
            diffHunk: '',  // GitLab doesn't return diff hunks on note objects
        };
    }

    private mapMR(data: any): PullRequest {
        let state: PullRequest['state'] = 'open';
        if (data.state === 'merged') { state = 'merged'; }
        else if (data.state === 'closed' || data.state === 'locked') { state = 'closed'; }

        // `draft` (newer) or `work_in_progress` (older); title prefix as a backstop.
        const isDraft = !!(data.draft ?? data.work_in_progress) || hasDraftTitle(data.title || '');

        // changes_count is a string, "N" or "N+" when GitLab capped the count.
        let changedFiles: number | undefined;
        if (typeof data.changes_count === 'string' && /^\d+\+?$/.test(data.changes_count)) {
            changedFiles = parseInt(data.changes_count, 10) + (data.changes_count.endsWith('+') ? 1 : 0);
        }

        return {
            id: data.id.toString(),
            number: data.iid,
            title: data.title,
            body: data.description || '',
            author: data.author?.username || 'unknown',
            authorAssociation: 'NONE',
            state,
            draft: isDraft,
            head: data.source_branch || '',
            headSha: data.sha || '',
            base: data.target_branch || '',
            url: data.web_url,
            apiUrl: `${this.baseUrl}/api/v4${this.project}/merge_requests/${data.iid}`,
            labels: data.labels || [],
            createdAt: new Date(data.created_at),
            updatedAt: new Date(data.updated_at),
            repo: this.key,
            ...(changedFiles !== undefined && { changedFiles }),
        };
    }
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/** Commit status → our state; anything not finished-and-green is pending or failed. */
function mapStatusState(status: string): CommitStatus['state'] {
    switch (status) {
        case 'success': return 'success';
        case 'failed': return 'failure';
        case 'canceled': return 'error';
        default: return 'pending'; // created, pending, running, manual, skipped, …
    }
}

/** Pipeline status → check-run status/conclusion. Never maps an unfinished pipeline to success. */
export function mapPipelineStatus(status: string): Pick<CheckRun, 'status' | 'conclusion'> {
    switch (status) {
        case 'created':
        case 'waiting_for_resource':
        case 'waiting_for_callback':
        case 'preparing':
        case 'pending':
        case 'scheduled':
            return { status: 'queued', conclusion: null };
        case 'running':
        case 'canceling':
            return { status: 'in_progress', conclusion: null };
        case 'success':
            return { status: 'completed', conclusion: 'success' };
        case 'failed':
            return { status: 'completed', conclusion: 'failure' };
        case 'canceled':
            return { status: 'completed', conclusion: 'cancelled' };
        case 'skipped':
            return { status: 'completed', conclusion: 'neutral' };
        case 'manual':
            // Blocked on a manual job: won't finish on its own, and isn't a pass.
            return { status: 'completed', conclusion: 'action_required' };
        default:
            return { status: 'completed', conclusion: 'action_required' };
    }
}

function encodePath(p: string): string {
    return p.split('/').map(encodeURIComponent).join('/');
}

/** Drop query strings from paths in error messages (they can carry user input). */
function redactQuery(path: string): string {
    const i = path.indexOf('?');
    return i === -1 ? path : path.slice(0, i);
}
