# Argus — AI Issue Agent

> *The hundred-eyed watchman that never sleeps.*

A VS Code extension that watches GitHub and GitLab repositories, triages new issues with an AI model, and — for issues a trusted person asks it to fix — writes the change, runs it through CI and opens a pull request with its full reasoning. It also posts a threat-assessment commit status on every open PR that branch protection can use as a merge gate.

Argus never merges. A human always reviews and merges.

## What it does

- **Triage** — evaluates each new issue (the model can read files from the repo before deciding) and labels it: merit, rejected, or needs human review.
- **Fixes, only when a trusted person asks** — code is written only for issues opened by a trusted user, or after a trusted user comments `/argus fix` on the issue. Everyone else gets triage labels and nothing more. See [Trust](#trust).
- **Contained code changes** — Argus may only modify files it read in full, never touches CI config, manifests, build scripts or hooks, keeps each change under `argus.maxDiffLines`, and commits each iteration atomically. It waits for CI on that exact commit and feeds failures back to the model.
- **PR transcript** — one comment with the evaluation, investigation and every iteration, in collapsible sections.
- **Merge gate** — every open PR (Argus's own included) gets an `argus/threat-assessment` commit status from a diff review. If the assessment fails or the model is unavailable, the status is `failure` with "human review required" — it never fails open.
- **Moderation** — new comments on issues and PRs Argus is working on are classified. Pattern matches alone never delete anything; deletion needs the model's confirmation, and auto-block is off by default.
- **Competing PRs** — when other PRs address the same issue, Argus ranks them and can post a plan for combining them (it doesn't open the combined PR).
- **Email** — optional notifications per event, with quiet hours.
- **Signed** — everything Argus posts carries an HMAC stamp, so it can recognize its own comments and ignore forged ones. Actions go to a hash-chained audit log.

## Quick start

1. Install the extension.
2. **Argus: Set GitHub Token** (or GitLab).
3. **Argus: Select AI Provider** and choose a model (see below).
4. **Argus: Add Repository**.
5. Turn on `argus.dryRun` for a first look, then **Argus: Start** from the sidebar.

## Choosing an AI provider

| Provider | Setting value | Needs | Notes |
|---|---|---|---|
| **Claude subscription** | `claude-code` | Claude Code installed and signed in | Uses your Claude Pro/Max plan — no API key. See below. |
| VS Code / GitHub Copilot | `vscode-lm` | A Copilot subscription (or another extension that provides models) | Copilot includes Claude models. |
| Anthropic API | `anthropic` | API key | Supports `argus.ai.effort`; falls back to another model when a safety classifier declines a security review. |
| OpenAI | `openai` | API key | |
| Google Gemini | `gemini` | API key | |
| Ollama | `ollama` | Local server | Nothing leaves your machine. |
| OpenAI-compatible | `openai-compatible` | Endpoint (+ key if required) | Groq, OpenRouter, vLLM, LM Studio, a gateway… |

API keys are stored in VS Code SecretStorage, one per provider.

### Claude subscription (`claude-code`)

Argus runs the Claude Code CLI that ships with the Claude Code extension (or one on your PATH, or `argus.ai.claudePath`) in headless mode, using your own existing sign-in. Argus never reads, stores or forwards your Claude credentials; run **Argus: Check Claude Code Login** to see whether you're signed in.

Each call runs with all tools disabled, no MCP servers, no settings or CLAUDE.md, no saved session, in an empty temporary folder.

Things to know:

- **Usage limits are shared** with your interactive Claude Code use. When the limit is hit, Argus pauses that issue and retries on a later poll.
- **The CLI tells the model your account email and some machine details.** This can't be turned off. Argus removes them from every reply and from everything it posts, but treat it as a reason to prefer `dryRun` until you're comfortable.
- **Terms of use.** Anthropic allows you to sign in to the unmodified Claude Code CLI with your own subscription. It does not allow third-party products to route other people's requests through subscription credentials. Use this provider for your own repositories, on your own machine.

## Trust

Argus reads text written by strangers, so who asked matters more than what they asked.

A user is **trusted** when they are in `argus.trust.trustedUsers`, or are an owner/member/collaborator of the repository (controlled by `argus.trust.treatMaintainersAsTrusted` / `treatReviewersAsTrusted`). Flags and blocks Argus has recorded against a user count against them.

- Issue opened by a trusted user → Argus may write a fix.
- Issue opened by anyone else → triage only. A trusted user can comment **`/argus fix`** (or `/argus approve`) to authorize the fix.
- If the issue is edited after Argus evaluated it, Argus stops before publishing and labels it `subversion-detected`.

## Safety switches

- `argus.dryRun` — nothing is written to GitHub/GitLab at all. Enforced underneath every component, so no code path can skip it.
- **Stop** — stops polling and aborts work in progress.
- **Emergency Stop** — the same, and every write stays blocked until you start Argus again.
- `argus.rateLimits.*` — hourly caps on comments, branches, PRs, pushes, issues and model calls; a daily cap on blocks.
- `argus.watchdogTimeoutMinutes` — maximum time on one issue.
- All Argus settings are user-level: a repository's `.vscode/settings.json` can't change them.

## Token permissions (GitHub fine-grained PAT)

| Permission | Access | Why |
|---|---|---|
| Contents | Read & write | Read code, create branches, commit |
| Issues | Read & write | Read issues, label, comment |
| Pull requests | Read & write | Open PRs, comment |
| Commit statuses | Read & write | Read CI, post the merge-gate status |

Self-hosted GitLab and GitHub Enterprise: add the repo by URL (or set `host` in the `argus.repos` entry). Tokens are stored per host, so a github.com token is never sent elsewhere.

## Architecture

```
src/
├── extension.ts          Activation and commands
├── agent/
│   ├── controller.ts     Per-repo scheduling, stop/halt, guarded forges
│   ├── pipeline.ts       One repo's cycle: poll → PRs → follow-ups → next issue
│   ├── state-store.ts    Persisted queue and history (survives restarts)
│   ├── evaluator.ts      Multi-turn triage with READ_FILES exploration
│   ├── investigator.ts   Gathers whole files and plans changes
│   ├── coder.ts          Generate → validate → atomic commit → CI loop
│   ├── transcriber.ts    The PR transcript comment
│   ├── pr-gatekeeper.ts  Merge-gate commit statuses
│   └── …                 Comment moderation, loop detection, competing PRs
├── forge/                GitHub and GitLab clients; guarded.ts enforces dry run, halt, redaction, rate limits
├── llm/                  Provider interface and providers (claude-code, vscode-lm, anthropic, …)
├── security/             Sanitizer, validator, diff assessor, threat classifier, trust
├── crypto/               Keys, stamps, nonces, audit log
├── notifications/        Email
└── ui/                   Tree views, status bar, settings webviews
```

## Security

See [SECURITY.md](SECURITY.md) for the threat model, what each defense does, and how to report a vulnerability.

## License

`SPDX-License-Identifier: Apache-2.0 OR MIT`

Dual-licensed under [Apache-2.0](LICENSE_APACHE2.TXT) or [MIT](LICENSE_MIT.TXT), at your option. See [LICENSE.txt](LICENSE.txt).
