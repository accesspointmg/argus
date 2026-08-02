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
    RepoRole,
    UserHistory,
    RepoKey,
    TreeEntry,
} from './types';
import { repoKey } from './types';

export class GitHubForge implements Forge {
    readonly platform: ForgePlatform = 'github';
    private readonly octokit: Octokit;
    private defaultBranchCache: string | null = null;

    constructor(
        readonly owner: string,
        readonly repo: string,
        token: string,
    ) {
        this.octokit = new Octokit({ auth: token });
    }

    get key(): RepoKey {
        return repoKey({ forge: 'github', owner: this.owner, repo: this.repo, pollIntervalMinutes: 0 });
    }

    // ─── Issues ─────────────────────────────────────────────────────

    async listNewIssues(since: Date): Promise<Issue[]> {
        const { data } = await this.octokit.issues.listForRepo({
            owner: this.owner,
            repo: this.repo,
            state: 'open',
            since: since.toISOString(),
            sort: 'created',
            direction: 'asc',
            per_page: 100,
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
        const { data } = await this.octokit.issues.listComments({
            owner: this.owner,
            repo: this.repo,
            issue_number: issueNumber,
            per_page: 100,
        });
        return data.map((c) => this.mapComment(c, issueNumber));
    }

    async getCommentsSince(issueNumber: number, since: Date): Promise<Comment[]> {
        const { data } = await this.octokit.issues.listComments({
            owner: this.owner,
            repo: this.repo,
            issue_number: issueNumber,
            since: since.toISOString(),
            per_page: 100,
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
        } catch {
            // Label may not exist — ignore
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
        const labels: string[] = [];
        let page = 1;
        for (;;) {
            const { data } = await this.octokit.issues.listLabelsForRepo({
                owner: this.owner,
                repo: this.repo,
                per_page: 100,
                page,
            });
            labels.push(...data.map((l) => l.name));
            if (data.length < 100) { break; }
            page++;
        }
        return labels;
    }

    // ─── Pull Requests ──────────────────────────────────────────────

    async listOpenPRs(): Promise<PullRequest[]> {
        const { data } = await this.octokit.pulls.list({
            owner: this.owner,
            repo: this.repo,
            state: 'open',
            per_page: 100,
        });
        return data.map((pr) => this.mapPR(pr));
    }

    async listPRsForIssue(issueNumber: number): Promise<PullRequest[]> {
        // GitHub doesn't have a direct "PRs for issue" API,
        // so we search for PRs mentioning the issue number
        const { data } = await this.octokit.pulls.list({
            owner: this.owner,
            repo: this.repo,
            state: 'open',
            per_page: 100,
        });

        const issueRef = `#${issueNumber}`;
        return data
            .filter((pr) => {
                const body = pr.body || '';
                const title = pr.title || '';
                return body.includes(issueRef) || title.includes(issueRef);
            })
            .map((pr) => this.mapPR(pr));
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
        const { data } = await this.octokit.issues.listComments({
            owner: this.owner,
            repo: this.repo,
            issue_number: prNumber,
            per_page: 100,
        });
        return data.map((c) => this.mapComment(c, prNumber));
    }

    async getPRReviewComments(prNumber: number): Promise<ReviewComment[]> {
        const { data } = await this.octokit.pulls.listReviewComments({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
            per_page: 100,
        });
        return data.map((c) => this.mapReviewComment(c, prNumber));
    }

    async getPRFiles(prNumber: number): Promise<FileChange[]> {
        const { data } = await this.octokit.pulls.listFiles({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
            per_page: 100,
        });
        return data.map((f) => ({
            path: f.filename,
            status: f.status as FileChange['status'],
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
        if (this.defaultBranchCache) { return this.defaultBranchCache; }
        const { data } = await this.octokit.repos.get({
            owner: this.owner,
            repo: this.repo,
        });
        this.defaultBranchCache = data.default_branch;
        return data.default_branch;
    }

    async createBranch(baseBranch: string, newBranch: string): Promise<void> {
        // Get the SHA of the base branch
        const { data: ref } = await this.octokit.git.getRef({
            owner: this.owner,
            repo: this.repo,
            ref: `heads/${baseBranch}`,
        });

        await this.octokit.git.createRef({
            owner: this.owner,
            repo: this.repo,
            ref: `refs/heads/${newBranch}`,
            sha: ref.object.sha,
        });
    }

    async getFileContent(branch: string, path: string): Promise<string> {
        const { data } = await this.octokit.repos.getContent({
            owner: this.owner,
            repo: this.repo,
            path,
            ref: branch,
        });

        if ('content' in data && data.content) {
            return Buffer.from(data.content, 'base64').toString('utf-8');
        }
        throw new Error(`File ${path} is not a file or has no content`);
    }

    async createOrUpdateFile(branch: string, path: string, content: string, message: string): Promise<void> {
        // Try to get the existing file's SHA
        let sha: string | undefined;
        try {
            const { data } = await this.octokit.repos.getContent({
                owner: this.owner,
                repo: this.repo,
                path,
                ref: branch,
            });
            if ('sha' in data) {
                sha = data.sha;
            }
        } catch {
            // File doesn't exist yet — that's fine for creation
        }

        await this.octokit.repos.createOrUpdateFileContents({
            owner: this.owner,
            repo: this.repo,
            path,
            message,
            content: Buffer.from(content).toString('base64'),
            branch,
            sha,
        });
    }

    async listTree(branch: string, path: string = '', recursive: boolean = false): Promise<TreeEntry[]> {
        if (recursive) {
            // Use the Git Trees API with recursive flag for the full tree
            const { data: refData } = await this.octokit.git.getRef({
                owner: this.owner,
                repo: this.repo,
                ref: `heads/${branch}`,
            });
            const { data: commitData } = await this.octokit.git.getCommit({
                owner: this.owner,
                repo: this.repo,
                commit_sha: refData.object.sha,
            });
            const { data: treeData } = await this.octokit.git.getTree({
                owner: this.owner,
                repo: this.repo,
                tree_sha: commitData.tree.sha,
                recursive: 'true',
            });
            let entries: TreeEntry[] = treeData.tree
                .filter((e): e is typeof e & { type: string; path: string } => !!e.type && !!e.path)
                .map((e) => ({
                    path: e.path!,
                    type: e.type === 'tree' ? 'tree' as const : 'blob' as const,
                    size: e.size,
                }));
            // Filter to path prefix if specified
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
            return [{ path: path || '', type: 'blob', size: (data as any).size }];
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
            description,
            ...(targetUrl && { target_url: targetUrl }),
        });
    }

    async getCommitStatuses(ref: string): Promise<CommitStatus[]> {
        const { data } = await this.octokit.repos.getCombinedStatusForRef({
            owner: this.owner,
            repo: this.repo,
            ref,
        });
        return data.statuses.map((s) => ({
            state: s.state as CommitStatus['state'],
            context: s.context,
            description: s.description || '',
            url: s.target_url || '',
        }));
    }

    async getCheckRuns(ref: string): Promise<CheckRun[]> {
        const { data } = await this.octokit.checks.listForRef({
            owner: this.owner,
            repo: this.repo,
            ref,
        });
        return data.check_runs.map((cr) => ({
            id: cr.id.toString(),
            name: cr.name,
            status: cr.status as CheckRun['status'],
            conclusion: cr.conclusion as CheckRun['conclusion'],
            url: cr.html_url || '',
            startedAt: cr.started_at ? new Date(cr.started_at) : undefined,
            completedAt: cr.completed_at ? new Date(cr.completed_at) : undefined,
        }));
    }

    async getCheckRunLog(checkRunId: string): Promise<string> {
        try {
            // GitHub's check run log endpoint returns a redirect to a zip
            // For simplicity, we get annotations which often contain failure info
            const { data } = await this.octokit.checks.listAnnotations({
                owner: this.owner,
                repo: this.repo,
                check_run_id: parseInt(checkRunId, 10),
            });
            return data.map((a) => `${a.path}:${a.start_line} [${a.annotation_level}] ${a.message}`).join('\n');
        } catch {
            return 'Unable to retrieve check run log';
        }
    }

    // ─── Code Search ────────────────────────────────────────────────

    async searchCode(query: string): Promise<CodeSearchResult[]> {
        const { data } = await this.octokit.search.code({
            q: `${query} repo:${this.owner}/${this.repo}`,
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
        try {
            const { data } = await this.octokit.repos.getCollaboratorPermissionLevel({
                owner: this.owner,
                repo: this.repo,
                username,
            });
            const permission = data.permission;
            const roleMap: Record<string, RepoRole> = {
                admin: 'admin',
                maintain: 'maintainer',
                write: 'write',
                triage: 'triage',
                read: 'read',
            };
            return roleMap[permission] || 'none';
        } catch {
            return 'none';
        }
    }

    async getUserHistory(username: string): Promise<UserHistory> {
        // Fetch merged PRs by this user
        let mergedPRs = 0;
        try {
            const { data } = await this.octokit.search.issuesAndPullRequests({
                q: `repo:${this.owner}/${this.repo} author:${username} type:pr is:merged`,
                per_page: 1,
            });
            mergedPRs = data.total_count;
        } catch { /* rate limit or permission error */ }

        // Fetch closed issues by this user
        let closedIssuesAsValid = 0;
        try {
            const { data } = await this.octokit.search.issuesAndPullRequests({
                q: `repo:${this.owner}/${this.repo} author:${username} type:issue is:closed`,
                per_page: 1,
            });
            closedIssuesAsValid = data.total_count;
        } catch { /* */ }

        // Get account creation date
        let accountCreatedAt: Date | undefined;
        try {
            const { data: user } = await this.octokit.users.getByUsername({ username });
            accountCreatedAt = new Date(user.created_at);
        } catch { /* */ }

        return {
            mergedPRs,
            closedIssuesAsValid,
            previousFlags: 0,  // Tracked locally by Argus, not via GitHub API
            previousBlocks: 0,
            totalComments: 0,
            accountCreatedAt,
        };
    }

    // ─── Moderation ─────────────────────────────────────────────────

    async deleteComment(commentId: string): Promise<void> {
        await this.octokit.issues.deleteComment({
            owner: this.owner,
            repo: this.repo,
            comment_id: parseInt(commentId, 10),
        });
    }

    async blockUser(username: string): Promise<void> {
        // Block at the org or user level (requires appropriate permissions)
        try {
            await this.octokit.request('PUT /user/blocks/{username}', { username });
        } catch {
            // May not have permission — log but don't fail
        }
    }

    async unblockUser(username: string): Promise<void> {
        try {
            await this.octokit.request('DELETE /user/blocks/{username}', { username });
        } catch { /* */ }
    }

    async reportUser(username: string, reason: string): Promise<void> {
        // GitHub doesn't have a public "report user" API.
        // This is a placeholder — in practice, this would create an internal record.
        console.warn(`Report user ${username}: ${reason} — GitHub has no report API`);
    }

    // ─── Token Validation ───────────────────────────────────────────

    async validateTokenScopes(): Promise<{ valid: boolean; warnings: string[]; errors: string[] }> {
        const warnings: string[] = [];
        const errors: string[] = [];

        try {
            const response = await this.octokit.request('GET /');
            const scopes = (response.headers['x-oauth-scopes'] as string || '').split(',').map((s) => s.trim());

            // Check for over-privileged scopes
            const dangerousScopes = ['delete_repo', 'admin:org', 'admin:repo_hook'];
            for (const scope of dangerousScopes) {
                if (scopes.includes(scope)) {
                    errors.push(`Token has '${scope}' permission which Argus should not have. Please create a more restrictive token.`);
                }
            }

            // Check for needed scopes
            const neededScopes = ['repo'];
            for (const scope of neededScopes) {
                if (!scopes.includes(scope)) {
                    warnings.push(`Token may be missing '${scope}' permission.`);
                }
            }

            return { valid: errors.length === 0, warnings, errors };
        } catch (err) {
            return { valid: false, warnings: [], errors: [`Token validation failed: ${err}`] };
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
            id: data.id.toString(),
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
            inReplyToId: data.in_reply_to_id?.toString(),
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private mapPR(data: any): PullRequest {
        let state: PullRequest['state'] = 'open';
        if (data.merged) { state = 'merged'; }
        else if (data.state === 'closed') { state = 'closed'; }

        return {
            id: data.id.toString(),
            number: data.number,
            title: data.title,
            body: data.body || '',
            author: data.user?.login || 'unknown',
            authorAssociation: data.author_association || 'NONE',
            state,
            draft: !!data.draft,
            head: data.head?.ref || '',
            headSha: data.head?.sha || '',
            base: data.base?.ref || '',
            url: data.html_url,
            apiUrl: data.url,
            labels: (data.labels || []).map((l: any) => (typeof l === 'string' ? l : l.name)),
            createdAt: new Date(data.created_at),
            updatedAt: new Date(data.updated_at),
            repo: this.key,
        };
    }
}
