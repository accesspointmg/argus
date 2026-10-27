// Copyright 2026 Colin Byrne. SPDX-License-Identifier: Apache-2.0 OR MIT

/**
 * Execution surface — files that run code during checkout, install, build,
 * test, CI, or in a developer's editor. One list, shared by the output
 * validator (Argus must never write these) and the diff assessor (a PR that
 * touches these needs scrutiny).
 *
 * Every rule matches at ANY depth (`sub/package.json`, `tools/build.sh`) and
 * case-insensitively, because checkouts on Windows and macOS are
 * case-insensitive and monorepos nest build files everywhere.
 */

import type { ExecutionSurfaceCategory, ExecutionSurfaceChange } from './types';

export interface SurfaceRule {
    pattern: RegExp;
    category: ExecutionSurfaceCategory;
    risk: ExecutionSurfaceChange['risk'];
    detail: string;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A file with this exact name, in any directory. */
function file(name: string): RegExp {
    return new RegExp(`(^|/)${esc(name)}$`, 'i');
}

/** Anything under a directory with this name (or path), at any depth. */
function dir(name: string): RegExp {
    return new RegExp(`(^|/)${esc(name)}/`, 'i');
}

/** A file whose basename matches the given basename regex source. */
function base(source: string): RegExp {
    return new RegExp(`(^|/)${source}$`, 'i');
}

function rule(
    pattern: RegExp,
    category: ExecutionSurfaceCategory,
    risk: SurfaceRule['risk'],
    detail: string,
): SurfaceRule {
    return { pattern, category, risk, detail };
}

/** Ordered by risk — first match wins. */
export const EXECUTION_SURFACE_RULES: readonly SurfaceRule[] = [
    // ── CI / CD (critical — they define what runs with secrets) ──
    rule(dir('.github/workflows'), 'ci_workflow', 'critical', 'GitHub Actions workflow'),
    rule(dir('.github/actions'), 'ci_workflow', 'critical', 'GitHub composite action'),
    rule(base('action\\.ya?ml'), 'ci_workflow', 'critical', 'GitHub Action definition'),
    rule(base('\\.gitlab-ci\\.ya?ml'), 'ci_workflow', 'critical', 'GitLab CI config'),
    rule(dir('.gitlab'), 'ci_workflow', 'critical', 'GitLab CI include / project config'),
    rule(file('Jenkinsfile'), 'ci_workflow', 'critical', 'Jenkins pipeline'),
    rule(dir('.circleci'), 'ci_workflow', 'critical', 'CircleCI config'),
    rule(file('.travis.yml'), 'ci_workflow', 'critical', 'Travis CI config'),
    rule(base('azure-pipelines[^/]*\\.ya?ml'), 'ci_workflow', 'critical', 'Azure Pipelines config'),
    rule(dir('.azure-pipelines'), 'ci_workflow', 'critical', 'Azure Pipelines config'),
    rule(file('bitbucket-pipelines.yml'), 'ci_workflow', 'critical', 'Bitbucket Pipelines config'),
    rule(dir('.buildkite'), 'ci_workflow', 'critical', 'Buildkite pipeline'),
    rule(base('\\.drone\\.ya?ml'), 'ci_workflow', 'critical', 'Drone CI config'),
    rule(base('\\.?appveyor\\.ya?ml'), 'ci_workflow', 'critical', 'AppVeyor config'),
    rule(dir('.woodpecker'), 'ci_workflow', 'critical', 'Woodpecker CI config'),
    rule(base('\\.woodpecker\\.ya?ml'), 'ci_workflow', 'critical', 'Woodpecker CI config'),
    rule(base('cloudbuild\\.ya?ml'), 'ci_workflow', 'critical', 'Cloud Build config'),
    rule(dir('.github'), 'repo_config', 'high', 'GitHub repo config (CODEOWNERS, bots, templates)'),
    rule(file('CODEOWNERS'), 'repo_config', 'high', 'Code ownership — controls required reviewers'),

    // ── Git (high — filter drivers and hooks execute on checkout/commit) ──
    rule(dir('.git'), 'git_config', 'critical', 'Git internals'),
    rule(file('.gitmodules'), 'git_config', 'high', 'Submodules — controls which repos the build fetches'),
    rule(file('.gitattributes'), 'git_config', 'high', 'Git attributes — filter drivers run commands on checkout'),
    rule(file('.gitconfig'), 'git_config', 'high', 'Git config'),
    rule(dir('.husky'), 'script', 'high', 'Git hook (Husky)'),
    rule(dir('.githooks'), 'script', 'high', 'Git hook'),
    rule(base('\\.?lefthook(-local)?\\.ya?ml'), 'script', 'high', 'Git hook config (Lefthook)'),
    rule(file('.pre-commit-config.yaml'), 'script', 'high', 'pre-commit hook config'),
    rule(base('\\.pre-commit-hooks\\.ya?ml'), 'script', 'high', 'pre-commit hook definition'),

    // ── Credentials and registries (high) ──
    rule(base('\\.env(\\.[^/]*)?'), 'credentials', 'high', 'Environment / secrets file'),
    rule(file('.envrc'), 'tooling', 'high', 'direnv — executes on cd'),
    rule(dir('.ssh'), 'credentials', 'high', 'SSH material'),
    rule(dir('.gnupg'), 'credentials', 'high', 'GPG material'),
    rule(dir('.aws'), 'credentials', 'high', 'AWS credentials'),
    rule(file('.netrc'), 'credentials', 'high', 'netrc credentials'),
    rule(base('[^/]*\\.(pem|key|p12|pfx|jks|keystore)'), 'credentials', 'high', 'Key material'),
    rule(base('id_(rsa|dsa|ecdsa|ed25519)(\\.pub)?'), 'credentials', 'high', 'SSH key'),
    rule(file('.npmrc'), 'dependency', 'high', 'npm config — can redirect registry / run scripts'),
    rule(base('\\.yarnrc(\\.ya?ml)?'), 'dependency', 'high', 'Yarn config'),
    rule(dir('.yarn'), 'dependency', 'high', 'Yarn plugins / releases (executable)'),
    rule(base('\\.pnpmfile\\.c?js'), 'dependency', 'high', 'pnpm hook file (executes on install)'),
    rule(file('.pypirc'), 'credentials', 'high', 'PyPI credentials'),
    rule(base('pip\\.(conf|ini)'), 'dependency', 'high', 'pip config — can redirect index'),
    rule(base('nuget\\.config'), 'dependency', 'high', 'NuGet config — can redirect feed'),
    rule(dir('.cargo'), 'dependency', 'high', 'Cargo config — can set build wrappers'),

    // ── Build systems (high — run at configure/build/test time) ──
    rule(file('CMakeLists.txt'), 'build_system', 'high', 'CMake — execute_process runs at configure time'),
    rule(base('[^/]*\\.cmake'), 'build_system', 'high', 'CMake module'),
    rule(base('(GNU)?makefile'), 'build_system', 'high', 'Makefile'),
    rule(base('[^/]*\\.mk'), 'build_system', 'high', 'Make include'),
    rule(base('meson(_options)?\\.(build|txt)'), 'build_system', 'high', 'Meson build definition'),
    rule(base('(BUILD|WORKSPACE|MODULE)(\\.bazel)?'), 'build_system', 'high', 'Bazel build definition'),
    rule(base('[^/]*\\.bzl'), 'build_system', 'high', 'Bazel extension'),
    rule(file('setup.py'), 'build_system', 'high', 'setup.py — executes on install'),
    rule(file('setup.cfg'), 'build_system', 'high', 'setup.cfg'),
    rule(file('pyproject.toml'), 'build_system', 'high', 'pyproject.toml — build backend / scripts'),
    rule(file('conftest.py'), 'build_system', 'high', 'pytest conftest — auto-executed by the test runner'),
    rule(base('(noxfile|fabfile|tasks|manage)\\.py'), 'build_system', 'high', 'Python task runner entry'),
    rule(file('tox.ini'), 'build_system', 'high', 'tox config'),
    rule(base('(build|settings)\\.gradle(\\.kts)?'), 'build_system', 'high', 'Gradle build script'),
    rule(base('gradlew(\\.bat)?'), 'build_system', 'high', 'Gradle wrapper'),
    rule(dir('gradle/wrapper'), 'build_system', 'high', 'Gradle wrapper'),
    rule(file('pom.xml'), 'build_system', 'high', 'Maven POM — plugins execute'),
    rule(base('mvnw(\\.cmd)?'), 'build_system', 'high', 'Maven wrapper'),
    rule(dir('.mvn'), 'build_system', 'high', 'Maven wrapper config'),
    rule(file('build.xml'), 'build_system', 'high', 'Ant build'),
    rule(file('build.rs'), 'build_system', 'high', 'Cargo build script — executes on build'),
    rule(base('(Rakefile|[^/]*\\.gemspec|[^/]*\\.rake)'), 'build_system', 'high', 'Ruby build / gem spec'),
    rule(base('(Gruntfile|gulpfile)\\.[cm]?[jt]s'), 'build_system', 'high', 'JS task runner'),
    rule(base('(webpack|vite|rollup|esbuild|babel|jest|vitest|karma|playwright|cypress|svelte|next|nuxt|astro|tailwind|postcss|eslint|prettier|stylelint)\\.config\\.[cm]?[jt]s'),
        'build_system', 'high', 'JS tool config (executable)'),
    rule(base('\\.(eslintrc|babelrc|prettierrc|mocharc|stylelintrc)(\\.[cm]?js)?'), 'build_system', 'medium', 'JS tool config'),
    rule(base('(justfile|Taskfile\\.ya?ml|Earthfile|Tiltfile|Procfile)'), 'build_system', 'high', 'Task runner'),
    rule(base('Directory\\.Build\\.(props|targets)'), 'build_system', 'high', 'MSBuild directory props'),
    rule(base('[^/]*\\.(csproj|vbproj|fsproj|vcxproj|props|targets)'), 'build_system', 'high', 'MSBuild project (can Exec)'),

    // ── Containers (high — define the build environment) ──
    rule(base('([^/]*\\.)?(dockerfile|containerfile)(\\.[^/]*)?'), 'container', 'high', 'Container build file'),
    rule(base('(docker-)?compose[^/]*\\.ya?ml'), 'container', 'high', 'Compose config'),
    rule(dir('.devcontainer'), 'container', 'high', 'Dev container config'),
    rule(file('.devcontainer.json'), 'container', 'high', 'Dev container config'),

    // ── Editor / agent tooling (high — runs commands or steers AI agents) ──
    rule(dir('.vscode'), 'tooling', 'high', 'VS Code workspace config (tasks run commands)'),
    rule(dir('.idea'), 'tooling', 'high', 'JetBrains workspace config'),
    rule(dir('.claude'), 'tooling', 'high', 'AI agent config'),
    rule(dir('.cursor'), 'tooling', 'high', 'AI agent config'),
    rule(dir('.continue'), 'tooling', 'high', 'AI agent config'),
    rule(base('(CLAUDE|AGENTS|GEMINI)\\.md'), 'tooling', 'medium', 'AI agent instructions'),
    rule(base('\\.cursorrules'), 'tooling', 'medium', 'AI agent instructions'),

    // ── Dependencies (medium — supply-chain vector) ──
    rule(file('package.json'), 'dependency', 'medium', 'package.json — scripts run arbitrary commands'),
    rule(base('(package-lock\\.json|npm-shrinkwrap\\.json|yarn\\.lock|pnpm-lock\\.yaml|pnpm-workspace\\.yaml|bun\\.lockb?)'), 'dependency', 'medium', 'JS lockfile / workspace'),
    rule(base('Gemfile(\\.lock)?'), 'dependency', 'medium', 'Ruby Gemfile'),
    rule(base('(requirements|constraints)[^/]*\\.(txt|in)'), 'dependency', 'medium', 'Python requirements'),
    rule(base('(Pipfile(\\.lock)?|poetry\\.lock|uv\\.lock|pdm\\.lock)'), 'dependency', 'medium', 'Python lockfile'),
    rule(base('go\\.(mod|sum|work)'), 'dependency', 'medium', 'Go module file'),
    rule(base('Cargo\\.(toml|lock)'), 'dependency', 'medium', 'Rust manifest / lockfile'),
    rule(base('packages\\.(config|lock\\.json)'), 'dependency', 'medium', 'NuGet packages'),
    rule(base('(vcpkg|vcpkg-configuration)\\.json'), 'dependency', 'medium', 'vcpkg manifest'),
    rule(base('conanfile\\.(txt|py)'), 'dependency', 'medium', 'Conan package file'),
    rule(base('composer\\.(json|lock)'), 'dependency', 'medium', 'PHP Composer'),
    rule(base('(mix\\.exs|mix\\.lock|Podfile(\\.lock)?|Package\\.swift|Package\\.resolved|pubspec\\.(yaml|lock))'), 'dependency', 'medium', 'Package manifest'),
    rule(base('(\\.tool-versions|\\.nvmrc|\\.node-version|\\.python-version|\\.ruby-version|rust-toolchain(\\.toml)?)'), 'dependency', 'medium', 'Toolchain pin'),

    // ── Scripts anywhere (medium) ──
    rule(base('[^/]*\\.(sh|bash|zsh|ksh|fish|ps1|psm1|psd1|bat|cmd|vbs)'), 'script', 'medium', 'Shell script'),
];

/** First matching rule for a (normalized, forward-slash) repo path. */
export function matchExecutionSurface(path: string): SurfaceRule | undefined {
    const p = path.replace(/\\/g, '/').replace(/^\.\/+/, '');
    return EXECUTION_SURFACE_RULES.find((r) => r.pattern.test(p));
}

export function isExecutionSurface(path: string): boolean {
    return matchExecutionSurface(path) !== undefined;
}

/** Classify a list of changed paths. Unmatched paths are omitted. */
export function classifyPaths(paths: readonly string[]): ExecutionSurfaceChange[] {
    const out: ExecutionSurfaceChange[] = [];
    for (const path of paths) {
        const r = matchExecutionSurface(path);
        if (r) { out.push({ path, category: r.category, risk: r.risk, detail: r.detail }); }
    }
    return out;
}

// ─── Path normalization ─────────────────────────────────────────

export type NormalizedPath = { ok: true; path: string } | { ok: false; reason: string };

const MAX_PATH_LENGTH = 1024;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

/**
 * Validate a repo-relative path from model output. Rejects anything that
 * could escape the repo or alias a protected file on some OS: absolute paths,
 * drive letters, `..`, `.` or empty segments, backslashes, NUL/control or
 * invisible characters, `~`, and segments with trailing dots/spaces (Windows
 * strips them, so `Makefile.` would become `Makefile` on checkout).
 */
export function normalizeRepoPath(raw: string): NormalizedPath {
    if (typeof raw !== 'string' || raw.length === 0) { return { ok: false, reason: 'empty path' }; }
    if (raw.length > MAX_PATH_LENGTH) { return { ok: false, reason: 'path too long' }; }
    if (CONTROL_CHARS.test(raw)) { return { ok: false, reason: 'control character in path' }; }
    if (INVISIBLE.test(raw)) { return { ok: false, reason: 'invisible/bidi character in path' }; }
    if (raw.includes('\\')) { return { ok: false, reason: 'backslash in path' }; }
    if (raw.startsWith('/')) { return { ok: false, reason: 'absolute path' }; }
    if (/^[a-zA-Z]:/.test(raw)) { return { ok: false, reason: 'drive letter in path' }; }
    if (raw.startsWith('~')) { return { ok: false, reason: 'home-relative path' }; }

    const segments = raw.split('/');
    for (const seg of segments) {
        if (seg === '') { return { ok: false, reason: 'empty path segment' }; }
        if (seg === '.' || seg === '..') { return { ok: false, reason: `"${seg}" segment in path` }; }
        if (/[. ]$/.test(seg)) { return { ok: false, reason: 'segment ends with dot or space' }; }
        if (seg.includes(':')) { return { ok: false, reason: 'colon in path (alternate data stream)' }; }
    }
    return { ok: true, path: raw };
}

/** Minimal glob → RegExp for `allowedPaths` (`*`, `**`, `?`). Case-insensitive. */
export function globToRegExp(glob: string): RegExp {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                // `**/` matches zero or more directories; bare `**` matches anything
                if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
            } else {
                re += '[^/]*';
            }
        } else if (c === '?') {
            re += '[^/]';
        } else {
            re += esc(c);
        }
    }
    return new RegExp(`^${re}$`, 'i');
}
