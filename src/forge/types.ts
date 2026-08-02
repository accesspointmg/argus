// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Forge types — the multi-platform abstraction for GitHub and GitLab.
 */

/** Supported forge platforms. */
export type ForgePlatform = 'github' | 'gitlab';

/** Configuration for a single monitored repository. */
export interface RepoConfig {
    forge: ForgePlatform;
    owner: string;
    repo: string;
    pollIntervalMinutes: number;
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
    closedIssuesAsValid: number;
    previousFlags: number;
    previousBlocks: number;
    totalComments: number;
    accountCreatedAt?: Date;
}

/**
 * The Forge interface — all forge operations Argus can perform.
 * Intentionally omits: merge, delete repo, modify settings, approve PRs.
 */
export interface Forge {
    readonly platform: ForgePlatform;
    readonly owner: string;
    readonly repo: string;

    // --- Issues ---
    listNewIssues(since: Date): Promise<Issue[]>;
    getIssue(issueNumber: number): Promise<Issue>;
    getIssueComments(issueNumber: number): Promise<Comment[]>;
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
    deleteComment(commentId: string): Promise<void>;
    blockUser(username: string): Promise<void>;
    unblockUser(username: string): Promise<void>;
    reportUser(username: string, reason: string): Promise<void>;

    // --- Token Validation ---
    validateTokenScopes(): Promise<{ valid: boolean; warnings: string[]; errors: string[] }>;
}
