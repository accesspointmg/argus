// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Forge types — the multi-platform abstraction for GitHub and GitLab.
 */

/** Supported forge platforms. */
export type ForgePlatform = 'github' | 'gitlab';

/** Per-repo email overrides. If omitted, the global Argus email config is used. */
export interface RepoEmailConfig {
    /** Recipients for this repo. Overrides the global default when set. */
    recipients?: string[];
    /** Optional per-repo SMTP — if omitted, the global SMTP transport is used. */
    smtp?: {
        host?: string;
        port?: number;
        secure?: boolean;
        user?: string;
    };
}

/** Configuration for a single monitored repository. */
export interface RepoConfig {
    forge: ForgePlatform;
    owner: string;
    repo: string;
    pollIntervalMinutes: number;
    /**
     * Self-hosted forge host (`gitlab.example.com`, `ghe.example.com`, optionally
     * with a path prefix like `example.com/gitlab`). Omitted = github.com / gitlab.com.
     */
    host?: string;
    /** Per-repo email overrides. Falls back to global Argus email if absent. */
    email?: RepoEmailConfig;
}

/** Unique identifier for a repo across forges. */
export type RepoKey = `${ForgePlatform}:${string}/${string}`;

export function repoKey(config: RepoConfig): RepoKey {
    return `${config.forge}:${config.owner}/${config.repo}`;
}

/** Issue as returned by the forge. */
export interface Issue {
    id: string;
    number: number;
    title: string;
    body: string;
    author: string;
    authorAssociation: string; // "OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "NONE"
    state: 'open' | 'closed';
    labels: string[];
    url: string;          // Web URL (clickable)
    apiUrl: string;       // API URL
    createdAt: Date;
    updatedAt: Date;
    repo: RepoKey;
}

/** Comment on an issue or PR. */
export interface Comment {
    /** Opaque id; pass back unchanged to `deleteComment`. */
    id: string;
    body: string;
    author: string;
    authorAssociation: string;
    url: string;
    createdAt: Date;
    updatedAt: Date;
    issueNumber: number;
}

/** Inline review comment on a PR (e.g., from GitHub Copilot, reviewers). */
export interface ReviewComment {
    /** Opaque id; pass back unchanged to `deleteComment`. */
    id: string;
    body: string;
    author: string;
    authorAssociation: string;
    url: string;
    createdAt: Date;
    updatedAt: Date;
    prNumber: number;
    /** File path the comment is on. */
    path: string;
    /** Line number in the diff (may be null for file-level comments). */
    line: number | null;
    /** Side of the diff: LEFT (deletion) or RIGHT (addition). */
    side: 'LEFT' | 'RIGHT';
    /** Snippet of the diff surrounding the comment. */
    diffHunk: string;
    /** If this is a reply, the ID of the parent comment. */
    inReplyToId?: string;
}

/** Pull request as returned by the forge. */
export interface PullRequest {
    id: string;
    number: number;
    title: string;
    body: string;
    author: string;
    authorAssociation: string;
    state: 'open' | 'closed' | 'merged';
    /** True when the PR/MR is a draft or has a WIP title prefix. */
    draft: boolean;
    head: string;        // Branch name
    headSha: string;     // HEAD commit SHA
    base: string;        // Target branch
    url: string;
    apiUrl: string;
    labels: string[];
    createdAt: Date;
    updatedAt: Date;
    repo: RepoKey;
    /**
     * Total changed files as reported by the forge, when known (single-PR fetch).
     * Compare with `getPRFiles().length` to detect a truncated file list.
     */
    changedFiles?: number;
}

/** A file change in a PR diff. */
export interface FileChange {
    path: string;
    status: 'added' | 'modified' | 'removed' | 'renamed';
    additions: number;
    deletions: number;
    patch?: string;
}

/** CI check run result. */
export interface CheckRun {
    id: string;
    name: string;
    status: 'queued' | 'in_progress' | 'completed';
    conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required' | null;
    url: string;
    startedAt?: Date;
    completedAt?: Date;
}

/** Combined commit status. */
export interface CommitStatus {
    state: 'pending' | 'success' | 'failure' | 'error';
    context: string;
    description: string;
    url: string;
}

/** Code search result from the forge. */
export interface CodeSearchResult {
    path: string;
    matchedLines: { lineNumber: number; text: string }[];
    url: string;
}

/** An entry in a repository tree listing. */
export interface TreeEntry {
    path: string;
    type: 'blob' | 'tree';  // file or directory
    size?: number;
}

/** User role in a repository. */
export type RepoRole = 'owner' | 'admin' | 'maintainer' | 'write' | 'triage' | 'read' | 'none';

/** User interaction history within a repo. */
export interface UserHistory {
    mergedPRs: number;
    /** Issues by this user closed as completed. */
    closedIssuesAsValid: number;
    /** Argus-side data: forges always return 0; TrustManager overlays persisted values. */
    previousFlags: number;
    /** Argus-side data: forges always return 0; TrustManager overlays persisted values. */
    previousBlocks: number;
    /** Not fetched (no cheap API); always 0 from forges. */
    totalComments: number;
    accountCreatedAt?: Date;
    /** True when some lookups failed (e.g. search rate limit) and counts are lower bounds. */
    incomplete?: boolean;
}

/** One file in an atomic commit. `content: null` deletes the file. */
export interface CommitFile {
    path: string;
    content: string | null;
}

/** Result of `validateTokenScopes`. */
export interface TokenValidation {
    valid: boolean;
    warnings: string[];
    errors: string[];
}

/**
 * Max items any list method returns (10 pages of 100). Lists longer than this are
 * truncated; GitHub PR files use GitHub's own 3000-file ceiling instead.
 */
export const MAX_LIST_ITEMS = 1000;

/**
 * The Forge interface — all forge operations Argus can perform.
 * Intentionally omits: merge, delete repo, modify settings, approve PRs.
 */
export interface Forge {
    readonly platform: ForgePlatform;
    readonly owner: string;
    readonly repo: string;

    // List methods paginate up to MAX_LIST_ITEMS.

    // --- Issues ---
    /** Open issues created or updated at/after `since` (oldest first). Excludes PRs. */
    listNewIssues(since: Date): Promise<Issue[]>;
    getIssue(issueNumber: number): Promise<Issue>;
    getIssueComments(issueNumber: number): Promise<Comment[]>;
    /** Comments created or edited at/after `since`. */
    getCommentsSince(issueNumber: number, since: Date): Promise<Comment[]>;
    addLabel(issueNumber: number, label: string): Promise<void>;
    removeLabel(issueNumber: number, label: string): Promise<void>;
    addComment(issueNumber: number, body: string): Promise<Comment>;
    /** Update an issue's title and/or body. */
    updateIssue(issueNumber: number, updates: { title?: string; body?: string }): Promise<void>;
    /** List all labels available in the repository. */
    listRepoLabels(): Promise<string[]>;

    // --- Pull Requests ---
    /** List all open PRs in the repo. */
    listOpenPRs(): Promise<PullRequest[]>;
    /**
     * Open PRs that reference `#N` as a whole token in title/body, or whose head
     * branch ends in `issue-N`. Anyone can open such a PR — check the author.
     */
    listPRsForIssue(issueNumber: number): Promise<PullRequest[]>;
    getPullRequest(prNumber: number): Promise<PullRequest>;
    getPRComments(prNumber: number): Promise<Comment[]>;
    /** Get inline review comments on a PR (code-level review feedback). */
    getPRReviewComments(prNumber: number): Promise<ReviewComment[]>;
    getPRFiles(prNumber: number): Promise<FileChange[]>;
    createPullRequest(head: string, base: string, title: string, body: string): Promise<PullRequest>;
    addPRComment(prNumber: number, body: string): Promise<Comment>;
    updatePRBody(prNumber: number, body: string): Promise<void>;

    // --- Branches & Files ---
    getDefaultBranch(): Promise<string>;
    createBranch(baseBranch: string, newBranch: string): Promise<void>;
    getFileContent(branch: string, path: string): Promise<string>;
    createOrUpdateFile(branch: string, path: string, content: string, message: string): Promise<void>;
    /** One atomic commit on `branch`; `content: null` deletes. Returns the new head SHA. */
    commitFiles(branch: string, files: CommitFile[], message: string): Promise<string>;
    branchExists(branch: string): Promise<boolean>;
    /** List files/dirs at a path in the repo tree. Returns paths relative to root. */
    listTree(branch: string, path?: string, recursive?: boolean): Promise<TreeEntry[]>;

    // --- CI ---
    getCommitStatuses(ref: string): Promise<CommitStatus[]>;
    createCommitStatus(
        ref: string,
        state: CommitStatus['state'],
        context: string,
        description: string,
        targetUrl?: string,
    ): Promise<void>;
    getCheckRuns(ref: string): Promise<CheckRun[]>;
    getCheckRunLog(checkRunId: string): Promise<string>;

    // --- Code Search ---
    searchCode(query: string): Promise<CodeSearchResult[]>;

    // --- Users ---
    getUserRole(username: string): Promise<RepoRole>;
    getUserHistory(username: string): Promise<UserHistory>;

    // --- Moderation ---
    /** Delete an issue/PR comment or review comment by the id a list method returned. */
    deleteComment(commentId: string): Promise<void>;
    /** Throws `UnsupportedError` where no repo/org-scoped block exists (GitLab). */
    blockUser(username: string): Promise<void>;
    unblockUser(username: string): Promise<void>;
    /** Neither forge has a report API: always throws `UnsupportedError`. */
    reportUser(username: string, reason: string): Promise<void>;

    // --- Token Validation ---
    /** Checks access to this repo and flags over-broad tokens. Never throws. */
    validateTokenScopes(): Promise<TokenValidation>;
}
