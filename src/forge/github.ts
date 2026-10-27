// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT


/**
 * GitHub forge implementation using @octokit/rest.
 */

import { Octokit } from '@octokit/rest';
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
import { UnsupportedError, httpStatus, isRemoteRateLimit } from './errors';
import { referencesIssue, isIssueBranch, hasDraftTitle, stripScopeQualifiers } from './util';

/** GitHub lists at most 3000 files per PR; fetch all of them so nothing hides past a cap. */
const MAX_PR_FILES = 3000;
/** GitHub rejects commit-status descriptions over 140 chars. */
const STATUS_DESCRIPTION_MAX = 140;
/** Tail of a job log returned by getCheckRunLog. */
const LOG_TAIL_CHARS = 20_000;

/** Review comment ids are prefixed so deleteComment uses the right endpoint. */
const REVIEW_PREFIX = 'review:';

export class GitHubForge implements Forge {
    readonly platform: ForgePlatform = 'github';
    private readonly octokit: Octokit;
    private repoInfoCache: { defaultBranch: string; ownerIsOrg: boolean } | null = null;

    /**
     * @param baseUrl GitHub Enterprise API root (`https://host/api/v3`); omit for github.com.
     */
    constructor(
        readonly owner: string,
        readonly repo: string,
        token: string,
        baseUrl?: string,
    ) {
        this.octokit = new Octokit({ auth: token, ...(baseUrl && { baseUrl }) });
    }

    get key(): RepoKey {
        return repoKey({ forge: 'github', owner: this.owner, repo: this.repo, pollIntervalMinutes: 0 });
    }

    /** Paginate a list endpoint (100/page) up to `maxItems`. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private async paginate<T = any>(method: any, params: Record<string, unknown>, maxItems = MAX_LIST_ITEMS): Promise<T[]> {
        const out: T[] = [];
        const iterator = this.octokit.paginate.iterator(method, {
            owner: this.owner,
            repo: this.repo,
            per_page: 100,
            ...params,
        });
        for await (const response of iterator) {
            out.push(...(response.data as T[]));
            if (out.length >= maxItems) { break; }
        }
        return out.slice(0, maxItems);
    }

    private async repoInfo(): Promise<{ defaultBranch: string; ownerIsOrg: boolean }> {
        if (!this.repoInfoCache) {
            const { data } = await this.octokit.repos.get({ owner: this.owner, repo: this.repo });
            this.repoInfoCache = {
                defaultBranch: data.default_branch,
                ownerIsOrg: data.owner?.type === 'Organization',
            };
        }
        return this.repoInfoCache;
    }

    // ─── Issues ─────────────────────────────────────────────────────

    async listNewIssues(since: Date): Promise<Issue[]> {
        // GitHub's `since` filters on updated_at: created-or-updated since.
        const data = await this.paginate(this.octokit.issues.listForRepo, {
            state: 'open',
            since: since.toISOString(),
            sort: 'updated',
            direction: 'asc',
        });
        return data
            .filter((i) => !i.pull_request) // Exclude PRs from issue list
            .map((i) => this.mapIssue(i));
    }

    async getIssue(issueNumber: number): Promise<Issue> {
        const { data } = await this.octokit.issues.get({
            owner: this.owner,
            repo: this.repo,
            issue_number: issueNumber,
        });
        return this.mapIssue(data);
    }

    async getIssueComments(issueNumber: number): Promise<Comment[]> {
        const data = await this.paginate(this.octokit.issues.listComments, { issue_number: issueNumber });
        return data.map((c) => this.mapComment(c, issueNumber));
    }

    async getCommentsSince(issueNumber: number, since: Date): Promise<Comment[]> {
        // `since` matches comments updated at/after the time, so edits are included.
        const data = await this.paginate(this.octokit.issues.listComments, {
            issue_number: issueNumber,
            since: since.toISOString(),
        });
        return data.map((c) => this.mapComment(c, issueNumber));
    }

    async addLabel(issueNumber: number, label: string): Promise<void> {
        await this.octokit.issues.addLabels({
            owner: this.owner,
            repo: this.repo,
            issue_number: issueNumber,
            labels: [label],
        });
    }

    async removeLabel(issueNumber: number, label: string): Promise<void> {
        try {
            await this.octokit.issues.removeLabel({
                owner: this.owner,
                repo: this.repo,
                issue_number: issueNumber,
                name: label,
            });
        } catch (err) {
            // Label not on the issue — already in the desired state.
            if (httpStatus(err) !== 404) { throw err; }
        }
    }

    async addComment(issueNumber: number, body: string): Promise<Comment> {
        const { data } = await this.octokit.issues.createComment({
            owner: this.owner,
            repo: this.repo,
            issue_number: issueNumber,
            body,
        });
        return this.mapComment(data, issueNumber);
    }

    async updateIssue(issueNumber: number, updates: { title?: string; body?: string }): Promise<void> {
        await this.octokit.issues.update({
            owner: this.owner,
            repo: this.repo,
            issue_number: issueNumber,
            ...(updates.title !== undefined && { title: updates.title }),
            ...(updates.body !== undefined && { body: updates.body }),
        });
    }

    async listRepoLabels(): Promise<string[]> {
        const data = await this.paginate(this.octokit.issues.listLabelsForRepo, {});
        return data.map((l) => l.name);
    }

    // ─── Pull Requests ──────────────────────────────────────────────

    async listOpenPRs(): Promise<PullRequest[]> {
        const data = await this.paginate(this.octokit.pulls.list, { state: 'open' });
        return data.map((pr) => this.mapPR(pr));
    }

    async listPRsForIssue(issueNumber: number): Promise<PullRequest[]> {
        // No direct "PRs for issue" API: scan open PRs for a whole-token reference.
        const prs = await this.listOpenPRs();
        return prs.filter((pr) =>
            referencesIssue(pr.title, issueNumber)
            || referencesIssue(pr.body, issueNumber)
            || isIssueBranch(pr.head, issueNumber));
    }

    async getPullRequest(prNumber: number): Promise<PullRequest> {
        const { data } = await this.octokit.pulls.get({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
        });
        return this.mapPR(data);
    }

    async getPRComments(prNumber: number): Promise<Comment[]> {
        return this.getIssueComments(prNumber);
    }

    async getPRReviewComments(prNumber: number): Promise<ReviewComment[]> {
        const data = await this.paginate(this.octokit.pulls.listReviewComments, { pull_number: prNumber });
        return data.map((c) => this.mapReviewComment(c, prNumber));
    }

    async getPRFiles(prNumber: number): Promise<FileChange[]> {
        const data = await this.paginate(this.octokit.pulls.listFiles, { pull_number: prNumber }, MAX_PR_FILES);
        return data.map((f) => ({
            path: f.filename,
            // GitHub also reports copied/changed/unchanged; fold them into the closest kind.
            status: f.status === 'added' || f.status === 'removed' || f.status === 'renamed'
                ? f.status
                : f.status === 'copied' ? 'added' : 'modified',
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch,
        }));
    }

    async createPullRequest(head: string, base: string, title: string, body: string): Promise<PullRequest> {
        const { data } = await this.octokit.pulls.create({
            owner: this.owner,
            repo: this.repo,
            head,
            base,
            title,
            body,
        });
        return this.mapPR(data);
    }

    async addPRComment(prNumber: number, body: string): Promise<Comment> {
        return this.addComment(prNumber, body);
    }

    async updatePRBody(prNumber: number, body: string): Promise<void> {
        await this.octokit.pulls.update({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
            body,
        });
    }

    // ─── Branches & Files ───────────────────────────────────────────

    async getDefaultBranch(): Promise<string> {
        return (await this.repoInfo()).defaultBranch;
    }

    async createBranch(baseBranch: string, newBranch: string): Promise<void> {
        const sha = await this.headSha(baseBranch);
        await this.octokit.git.createRef({
            owner: this.owner,
            repo: this.repo,
            ref: `refs/heads/${newBranch}`,
            sha,
        });
    }

    async branchExists(branch: string): Promise<boolean> {
        try {
            await this.headSha(branch);
            return true;
        } catch (err) {
            if (httpStatus(err) === 404) { return false; }
            throw err;
        }
    }

    private async headSha(branch: string): Promise<string> {
        const { data } = await this.octokit.git.getRef({
            owner: this.owner,
            repo: this.repo,
            ref: `heads/${branch}`,
        });
        return data.object.sha;
    }

    async getFileContent(branch: string, path: string): Promise<string> {
        const { data } = await this.octokit.repos.getContent({
            owner: this.owner,
            repo: this.repo,
            path,
            ref: branch,
        });

        if (Array.isArray(data) || data.type !== 'file') {
            throw new Error(`${path} is not a file`);
        }
        if ('content' in data && data.content) {
            return Buffer.from(data.content, 'base64').toString('utf-8');
        }
        // Files over 1 MB come back without content; the blob API serves up to 100 MB.
        if (data.size > 0) {
            const { data: blob } = await this.octokit.git.getBlob({
                owner: this.owner,
                repo: this.repo,
                file_sha: data.sha,
            });
            return Buffer.from(blob.content, 'base64').toString('utf-8');
        }
        return '';
    }

    async createOrUpdateFile(branch: string, path: string, content: string, message: string): Promise<void> {
        await this.commitFiles(branch, [{ path, content }], message);
    }

    async commitFiles(branch: string, files: CommitFile[], message: string): Promise<string> {
        const parentSha = await this.headSha(branch);
        if (files.length === 0) { return parentSha; }

        const { data: parent } = await this.octokit.git.getCommit({
            owner: this.owner,
            repo: this.repo,
            commit_sha: parentSha,
        });
        // One recursive tree read tells us which paths exist and which are executable.
        const { data: baseTree } = await this.octokit.git.getTree({
            owner: this.owner,
            repo: this.repo,
            tree_sha: parent.tree.sha,
            recursive: 'true',
        });
        const modes = new Map<string, string>();
        for (const e of baseTree.tree) {
            if (e.path && e.mode) { modes.set(e.path, e.mode); }
        }

        type TreeItem = { path: string; mode: '100644' | '100755'; type: 'blob'; content?: string; sha?: string | null };
        const tree: TreeItem[] = [];
        for (const f of files) {
            const existing = modes.get(f.path);
            if (f.content === null) {
                // Deleting a path that isn't there fails the whole tree; skip it
                // (only provable when the listing wasn't truncated).
                if (!existing && !baseTree.truncated) { continue; }
                tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null });
            } else {
                // Keep the executable bit; never write through a symlink/submodule entry.
                const mode = existing === '100755' ? '100755' : '100644';
                tree.push({ path: f.path, mode, type: 'blob', content: f.content });
            }
        }
        if (tree.length === 0) { return parentSha; }

        const { data: newTree } = await this.octokit.git.createTree({
            owner: this.owner,
            repo: this.repo,
            base_tree: parent.tree.sha,
            tree, // sha: null deletes the path
        });
        if (newTree.sha === parent.tree.sha) { return parentSha; } // no-op change

        const { data: commit } = await this.octokit.git.createCommit({
            owner: this.owner,
            repo: this.repo,
            message,
            tree: newTree.sha,
            parents: [parentSha],
        });
        // Fast-forward only: fails if the branch moved since we read it.
        await this.octokit.git.updateRef({
            owner: this.owner,
            repo: this.repo,
            ref: `heads/${branch}`,
            sha: commit.sha,
            force: false,
        });
        return commit.sha;
    }

    async listTree(branch: string, path: string = '', recursive: boolean = false): Promise<TreeEntry[]> {
        if (recursive) {
            // Git Trees API, recursive. GitHub truncates very large trees (~100k entries / 7 MB).
            const { data: commitData } = await this.octokit.git.getCommit({
                owner: this.owner,
                repo: this.repo,
                commit_sha: await this.headSha(branch),
            });
            const { data: treeData } = await this.octokit.git.getTree({
                owner: this.owner,
                repo: this.repo,
                tree_sha: commitData.tree.sha,
                recursive: 'true',
            });
            let entries: TreeEntry[] = treeData.tree
                .filter((e) => (e.type === 'blob' || e.type === 'tree') && !!e.path)
                .map((e) => ({
                    path: e.path!,
                    type: e.type === 'tree' ? 'tree' as const : 'blob' as const,
                    size: e.size,
                }));
            if (path) {
                const prefix = path.endsWith('/') ? path : path + '/';
                entries = entries.filter((e) => e.path.startsWith(prefix));
            }
            return entries;
        }

        // Non-recursive: use the Contents API to list a single directory
        const { data } = await this.octokit.repos.getContent({
            owner: this.owner,
            repo: this.repo,
            path: path || '',
            ref: branch,
        });
        if (!Array.isArray(data)) {
            return [{ path: data.path || path, type: 'blob', size: data.size }];
        }
        return data.map((item) => ({
            path: item.path,
            type: item.type === 'dir' ? 'tree' as const : 'blob' as const,
            size: item.size,
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
        await this.octokit.repos.createCommitStatus({
            owner: this.owner,
            repo: this.repo,
            sha: ref,
            state,
            context,
            description: truncate(description, STATUS_DESCRIPTION_MAX),
            ...(targetUrl && { target_url: targetUrl }),
        });
    }

    async getCommitStatuses(ref: string): Promise<CommitStatus[]> {
        // Combined status = latest status per context. Not a plain list, so page manually.
        const out: CommitStatus[] = [];
        for (let page = 1; page <= MAX_LIST_ITEMS / 100; page++) {
            const { data } = await this.octokit.repos.getCombinedStatusForRef({
                owner: this.owner,
                repo: this.repo,
                ref,
                per_page: 100,
                page,
            });
            out.push(...data.statuses.map((s) => ({
                state: s.state as CommitStatus['state'],
                context: s.context,
                description: s.description || '',
                url: s.target_url || '',
            })));
            if (data.statuses.length < 100) { break; }
        }
        return out;
    }

    async getCheckRuns(ref: string): Promise<CheckRun[]> {
        // Empty array = no check runs exist; callers must not read that as passing.
        const data = await this.paginate(this.octokit.checks.listForRef, { ref, filter: 'latest' });
        return data.map((cr) => ({
            id: cr.id.toString(),
            name: cr.name,
            status: mapCheckStatus(cr.status),
            conclusion: cr.status === 'completed' ? mapCheckConclusion(cr.conclusion) : null,
            url: cr.html_url || '',
            startedAt: cr.started_at ? new Date(cr.started_at) : undefined,
            completedAt: cr.completed_at ? new Date(cr.completed_at) : undefined,
        }));
    }

    async getCheckRunLog(checkRunId: string): Promise<string> {
        const id = parseInt(checkRunId, 10);
        const parts: string[] = [];
        try {
            const { data: run } = await this.octokit.checks.get({ owner: this.owner, repo: this.repo, check_run_id: id });
            const out = [run.output?.title, run.output?.summary, run.output?.text].filter(Boolean).join('\n');
            if (out) { parts.push(out); }

            const annotations = await this.paginate(this.octokit.checks.listAnnotations, { check_run_id: id }, 200);
            if (annotations.length) {
                parts.push(annotations.map((a) => `${a.path}:${a.start_line} [${a.annotation_level}] ${a.message}`).join('\n'));
            }

            // For GitHub Actions the check run id is the job id; the job log is the real signal.
            if (run.app?.slug === 'github-actions') {
                try {
                    const { data: log } = await this.octokit.actions.downloadJobLogsForWorkflowRun({
                        owner: this.owner,
                        repo: this.repo,
                        job_id: id,
                    });
                    const text = typeof log === 'string' ? log : String(log);
                    parts.push(`=== job log (tail) ===\n${text.slice(-LOG_TAIL_CHARS)}`);
                } catch { /* logs expired or no actions:read — annotations still help */ }
            }
        } catch (err) {
            parts.push(`Unable to retrieve check run log (${httpStatus(err) ?? 'error'})`);
        }
        return parts.join('\n\n') || 'No log output available';
    }

    // ─── Code Search ────────────────────────────────────────────────

    async searchCode(query: string): Promise<CodeSearchResult[]> {
        const q = stripScopeQualifiers(query);
        if (!q) { return []; }
        const { data } = await this.octokit.search.code({
            q: `${q} repo:${this.owner}/${this.repo}`,
            per_page: 20,
        });
        return data.items.map((item) => ({
            path: item.path,
            matchedLines: [], // GitHub code search doesn't return line content in API
            url: item.html_url,
        }));
    }

    // ─── Users ──────────────────────────────────────────────────────

    async getUserRole(username: string): Promise<RepoRole> {
        if (username.toLowerCase() === this.owner.toLowerCase()) {
            try {
                if (!(await this.repoInfo()).ownerIsOrg) { return 'owner'; }
            } catch { /* fall through to the permission check */ }
        }
        try {
            const { data } = await this.octokit.repos.getCollaboratorPermissionLevel({
                owner: this.owner,
                repo: this.repo,
                username,
            });
            // role_name carries maintain/triage; `permission` is the legacy admin/write/read.
            const roleMap: Record<string, RepoRole> = {
                admin: 'admin',
                maintain: 'maintainer',
                write: 'write',
                triage: 'triage',
                read: 'read',
            };
            return roleMap[data.role_name] || roleMap[data.permission] || 'none';
        } catch {
            return 'none'; // fail closed
        }
    }

    /**
     * Search-backed counts (GitHub search: 30 req/min). Two `per_page: 1` queries;
     * on a rate limit the remaining lookups are skipped and `incomplete` is set.
     * previousFlags/previousBlocks/totalComments are always 0 here — TrustManager
     * overlays Argus's persisted history.
     */
    async getUserHistory(username: string): Promise<UserHistory> {
        let incomplete = false;
        let rateLimited = false;
        const count = async (q: string): Promise<number> => {
            if (rateLimited) { incomplete = true; return 0; }
            try {
                const { data } = await this.octokit.search.issuesAndPullRequests({ q, per_page: 1 });
                if (data.incomplete_results) { incomplete = true; }
                return data.total_count;
            } catch (err) {
                incomplete = true;
                if (isRemoteRateLimit(err)) { rateLimited = true; }
                return 0;
            }
        };
        const scope = `repo:${this.owner}/${this.repo} author:${username}`;
        const mergedPRs = await count(`${scope} type:pr is:merged`);
        const closedIssuesAsValid = await count(`${scope} type:issue is:closed reason:completed`);

        let accountCreatedAt: Date | undefined;
        try {
            const { data: user } = await this.octokit.users.getByUsername({ username });
            accountCreatedAt = new Date(user.created_at);
        } catch {
            incomplete = true;
        }

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
        if (commentId.startsWith(REVIEW_PREFIX)) {
            await this.octokit.pulls.deleteReviewComment({
                owner: this.owner,
                repo: this.repo,
                comment_id: parseCommentNumber(commentId.slice(REVIEW_PREFIX.length)),
            });
            return;
        }
        await this.octokit.issues.deleteComment({
            owner: this.owner,
            repo: this.repo,
            comment_id: parseCommentNumber(commentId),
        });
    }

    /** Org-level block for org-owned repos; otherwise blocks on the token owner's account. */
    async blockUser(username: string): Promise<void> {
        if ((await this.repoInfo()).ownerIsOrg) {
            await this.octokit.request('PUT /orgs/{org}/blocks/{username}', { org: this.owner, username });
        } else {
            await this.octokit.request('PUT /user/blocks/{username}', { username });
        }
    }

    async unblockUser(username: string): Promise<void> {
        if ((await this.repoInfo()).ownerIsOrg) {
            await this.octokit.request('DELETE /orgs/{org}/blocks/{username}', { org: this.owner, username });
        } else {
            await this.octokit.request('DELETE /user/blocks/{username}', { username });
        }
    }

    async reportUser(_username: string, _reason: string): Promise<void> {
        throw new UnsupportedError('reportUser', 'GitHub has no API for reporting users');
    }

    // ─── Token Validation ───────────────────────────────────────────

    /**
     * Classic PATs list scopes in `x-oauth-scopes`; fine-grained PATs and app tokens
     * don't, so we read `permissions` from the repo itself. For fine-grained tokens
     * GitHub reports the user's role there, so a token missing e.g. Contents:write
     * still surfaces as a 403 on first write.
     */
    async validateTokenScopes(): Promise<TokenValidation> {
        const warnings: string[] = [];
        const errors: string[] = [];
        try {
            const response = await this.octokit.repos.get({ owner: this.owner, repo: this.repo });
            const scopeHeader = response.headers['x-oauth-scopes'];
            const perms = response.data.permissions;

            if (perms && !perms.pull) {
                errors.push(`Token cannot read ${this.owner}/${this.repo}.`);
            } else if (perms && !perms.push) {
                warnings.push('Token has no write access to this repository: Argus can triage but not push branches, open PRs, or post statuses.');
            }
            if (perms?.admin) {
                warnings.push('Token has admin rights on this repository; a write/maintain token is enough for Argus.');
            }

            if (typeof scopeHeader === 'string') {
                const scopes = scopeHeader.split(',').map((s) => s.trim()).filter(Boolean);
                const dangerous = ['delete_repo', 'admin:org', 'admin:repo_hook', 'admin:org_hook', 'admin:enterprise', 'site_admin', 'admin:public_key', 'admin:gpg_key'];
                for (const scope of dangerous) {
                    if (scopes.includes(scope)) {
                        errors.push(`Token has '${scope}' which Argus should not have. Create a more restrictive token.`);
                    }
                }
                if (scopes.includes('workflow')) {
                    warnings.push("Token has the 'workflow' scope, which lets it change CI workflows. Argus never needs it.");
                }
                if (!scopes.includes('repo') && !scopes.includes('public_repo')) {
                    warnings.push("Classic token lacks the 'repo' (or 'public_repo') scope; writes will fail.");
                } else if (scopes.includes('repo')) {
                    warnings.push("Classic 'repo' scope grants access to every repository you can reach; prefer a fine-grained token limited to monitored repos.");
                }
            }
            return { valid: errors.length === 0, warnings, errors };
        } catch (err) {
            const status = httpStatus(err);
            const why = status === 401 ? 'token is invalid or expired'
                : status === 404 ? 'repository not found or not visible to this token'
                : status === 403 ? 'access forbidden (SSO authorization or permissions)'
                : String(err instanceof Error ? err.message : err);
            return { valid: false, warnings, errors: [`Token validation failed: ${why}`] };
        }
    }

    // ─── Private Mappers ────────────────────────────────────────────

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private mapIssue(data: any): Issue {
        return {
            id: data.id.toString(),
            number: data.number,
            title: data.title,
            body: data.body || '',
            author: data.user?.login || 'unknown',
            authorAssociation: data.author_association || 'NONE',
            state: data.state as Issue['state'],
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            labels: (data.labels || []).map((l: any) => (typeof l === 'string' ? l : l.name)),
            url: data.html_url,
            apiUrl: data.url,
            createdAt: new Date(data.created_at),
            updatedAt: new Date(data.updated_at),
            repo: this.key,
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private mapComment(data: any, issueNumber: number): Comment {
        return {
            id: data.id.toString(),
            body: data.body || '',
            author: data.user?.login || 'unknown',
            authorAssociation: data.author_association || 'NONE',
            url: data.html_url,
            createdAt: new Date(data.created_at),
            updatedAt: new Date(data.updated_at),
            issueNumber,
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private mapReviewComment(data: any, prNumber: number): ReviewComment {
        return {
            id: `${REVIEW_PREFIX}${data.id}`,
            body: data.body || '',
            author: data.user?.login || 'unknown',
            authorAssociation: data.author_association || 'NONE',
            url: data.html_url,
            createdAt: new Date(data.created_at),
            updatedAt: new Date(data.updated_at),
            prNumber,
            path: data.path || '',
            line: data.line ?? data.original_line ?? null,
            side: data.side === 'LEFT' ? 'LEFT' : 'RIGHT',
            diffHunk: data.diff_hunk || '',
            inReplyToId: data.in_reply_to_id ? `${REVIEW_PREFIX}${data.in_reply_to_id}` : undefined,
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private mapPR(data: any): PullRequest {
        let state: PullRequest['state'] = 'open';
        // `merged` is only on single-PR responses; lists carry `merged_at`.
        if (data.merged || data.merged_at) { state = 'merged'; }
        else if (data.state === 'closed') { state = 'closed'; }

        return {
            id: data.id.toString(),
            number: data.number,
            title: data.title,
            body: data.body || '',
            author: data.user?.login || 'unknown',
            authorAssociation: data.author_association || 'NONE',
            state,
            draft: !!data.draft || hasDraftTitle(data.title || ''),
            head: data.head?.ref || '',
            headSha: data.head?.sha || '',
            base: data.base?.ref || '',
            url: data.html_url,
            apiUrl: data.url,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            labels: (data.labels || []).map((l: any) => (typeof l === 'string' ? l : l.name)),
            createdAt: new Date(data.created_at),
            updatedAt: new Date(data.updated_at),
            repo: this.key,
            ...(typeof data.changed_files === 'number' && { changedFiles: data.changed_files }),
        };
    }
}

function truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function parseCommentNumber(id: string): number {
    if (!/^\d+$/.test(id)) { throw new Error(`Invalid GitHub comment id: ${id}`); }
    return Number(id);
}

function mapCheckStatus(status: string): CheckRun['status'] {
    if (status === 'completed') { return 'completed'; }
    if (status === 'in_progress') { return 'in_progress'; }
    return 'queued'; // queued, requested, waiting, pending
}

/** Unknown/new conclusions map to a non-passing value. */
function mapCheckConclusion(conclusion: string | null): CheckRun['conclusion'] {
    switch (conclusion) {
        case 'success':
        case 'failure':
        case 'neutral':
        case 'cancelled':
        case 'timed_out':
        case 'action_required':
            return conclusion;
        case 'skipped':
            return 'neutral';
        case 'stale':
            return 'cancelled';
        default:
            return 'failure'; // startup_failure, null on a completed run, anything new
    }
}
