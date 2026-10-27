// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

export type {
    Forge,
    ForgePlatform,
    Issue,
    Comment,
    PullRequest,
    FileChange,
    CheckRun,
    CommitStatus,
    CodeSearchResult,
    RepoConfig,
    RepoKey,
    RepoRole,
    UserHistory,
    TreeEntry,
    CommitFile,
    TokenValidation,
    ReviewComment,
} from './types';
export { repoKey, MAX_LIST_ITEMS } from './types';
export { UnsupportedError, HaltedError, ForgeRateLimitError, ForgeHttpError } from './errors';
export type { WriteKind } from './errors';
export { GuardedForge, HourlyWriteLimiter } from './guarded';
export type { WriteLimiter, WriteLimit, GuardedForgeOptions } from './guarded';
export { GitHubForge } from './github';
export { GitLabForge } from './gitlab';
export { createForge } from './factory';
