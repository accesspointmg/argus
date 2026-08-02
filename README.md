# Argus — AI Issue Agent

> *The hundred-eyed watchman that never sleeps.*

A VS Code extension that autonomously triages GitHub/GitLab issues, investigates code, creates branches, and opens pull requests with full AI reasoning transcripts. Adversary-aware. Cryptographically stamped. Never merges.

## Features

- **Issue Triage** — Polls repos for new issues, evaluates technical merit with the AI provider of your choice
- **Agentic Evaluation** — Multi-turn LLM exploration of the full codebase via READ_FILES protocol before rendering judgment
- **Code Investigation** — Reads relevant source files, searches for error patterns, builds context
- **Autonomous Coding** — Creates branches, iterates on fixes, monitors CI results
- **Pull Request Management** — Opens PRs with detailed reasoning transcripts as comments
- **Issue Acknowledgment** — Posts stamped comments on issues linking to the PR, with category/severity/approach
- **Comment Monitoring** — Watches for new issue comments, runs moderation, logs clean feedback on the PR
- **PR Review Feedback** — Reads and acknowledges inline review comments (e.g., from GitHub Copilot, human reviewers)
- **Competitive PR Analysis** — Evaluates competing PRs, ranks solutions, synthesizes super PRs
- **Smart Skip Logic** — Avoids re-processing issues where Argus already has the last word
- **Confidence Safety Net** — Low-confidence rejections auto-flip to accepted for investigation
- **12-Layer Security** — Input sanitization, cryptographic LLM framing, threat classification, session isolation, output validation, HMAC stamps, tamper detection, scope-locked tokens, rate limiting, chained audit log, watchdog timers, multi-instance sovereignty
- **Graduated Trust Model** — Role-aware, history-informed user trust with proportional response
- **Multi-Forge** — GitHub and GitLab from a single abstraction
- **Token Management** — Set, clear, and list authentication tokens from the command palette
- **Email Notifications** — Configurable per-event with SMTP support
- **Cryptographic Identity** — HMAC-SHA256 stamps on every artifact, anti-replay nonces

## Quick Start

1. Install the extension
2. Open the command palette and run **Argus: Set GitHub Token** (or GitLab)
3. Run **Argus: Select AI Provider** and pick the model Argus should think with
4. Add repos via **Argus: Add Repository** or configure `argus.repos` in settings
5. Click **Start** in the Argus sidebar panel

### Choosing an AI Provider

Argus needs a language model, but it does not care which one. **Argus: Select AI
Provider** walks through the choice and stores any API key in VS Code's
SecretStorage (keys are held per provider, so switching back and forth does not
mean re-entering them).

| Provider | Setting value | Needs a key | Notes |
|---|---|---|---|
| VS Code / GitHub Copilot | `vscode-lm` | No | The default. Uses any chat model VS Code already provides; set `argus.ai.vendor` to select a non-Copilot one. |
| Anthropic Claude | `anthropic` | Yes | Adaptive thinking on, with an automatic fallback model when a safety classifier declines a security review. |
| OpenAI | `openai` | Yes | |
| Google Gemini | `gemini` | Yes | |
| Ollama | `ollama` | No | Runs on your machine — nothing leaves the host. Worth considering for private repositories. |
| Anything OpenAI-compatible | `openai-compatible` | Usually | Groq, Together, OpenRouter, vLLM, LM Studio, a corporate gateway. Point `argus.ai.baseUrl` at it. |

The flow is **provider → endpoint → key → model → effort**, and that order
matters: the model list is fetched live from the vendor, which can't happen
before the key exists. You pick from what your key can actually reach — Ollama
lists what you've pulled, Anthropic and Gemini show context windows — rather
than typing a model name from memory and finding the typo as a 404 later. If a
vendor is unreachable or a self-hosted server has no listing route, it falls
back to a text box.

`argus.ai.effort` controls how hard the model thinks (`low` … `max`). It's
honored by the Anthropic provider; the others ignore it rather than guessing at
an equivalent knob, since sending the wrong one is a 400. Leave it at `default`
unless you have a reason — and note `xhigh`/`max` are rejected by older models.

Two related settings that aren't per-model: `argus.ai.maxTokens` caps a single
reply (needs headroom — code generation returns whole files), and
`argus.rateLimits.llmCallsPerHour` bounds spend across all repositories.

Adding a provider means one file under `src/llm/providers/` — nothing outside
that folder knows which vendors exist.

### Required GitHub PAT Permissions (Fine-Grained)

| Permission | Access | Why |
|---|---|---|
| Contents | Read & Write | Read code, create branches, commit files |
| Issues | Read & Write | Read issues, add labels, post comments |
| Pull requests | Read & Write | Create PRs, post review acknowledgments |
| Commit statuses | Read & Write | Monitor CI results, post threat assessment verdicts |

## Architecture

```
src/
├── extension.ts          # Activation, commands, token management, polling
├── forge/                # Multi-forge abstraction (GitHub + GitLab)
│   ├── types.ts          # Forge interface, Issue, Comment, ReviewComment, PR types
│   ├── github.ts         # GitHub implementation via @octokit/rest
│   ├── gitlab.ts         # GitLab implementation via REST API v4
│   └── factory.ts        # Forge creation, token helpers
├── agent/                # Issue evaluation, coding, PR analysis
│   ├── evaluator.ts      # Multi-turn agentic evaluation with READ_FILES protocol
│   ├── investigator.ts   # Code search, file-level analysis
│   ├── coder.ts          # Iterative LLM code generation + CI loop
│   ├── pipeline.ts       # Main orchestrator — poll → evaluate → code → PR → monitor
│   ├── transcriber.ts    # Formats AI reasoning as structured PR comments
│   ├── comment-handler.ts # Comment moderation with threat assessment
│   ├── edit-detector.ts  # Detects mid-flight issue edits
│   └── pr-analyzer.ts    # Competitive PR analysis & synthesis
├── llm/                  # Provider abstraction — one interface, any vendor
│   ├── types.ts          # ChatRequest/ChatMessage, LlmProvider, errors
│   ├── service.ts        # Resolves argus.ai.* settings into a live provider
│   ├── setup.ts          # "Select AI Provider" / "Set AI Provider Key"
│   └── providers/        # vscode-lm, anthropic, openai, gemini, ollama
├── security/             # Sanitization, threat classification, trust model
├── crypto/               # HMAC-SHA256 stamps, key management, audit log
├── notifications/        # Email system (SMTP)
├── ui/                   # TreeView, status bar, webview panels
└── util/                 # Config, queue, logger, rate limiter
```

## Pipeline Flow

```
Poll repo → Skip if last word → Evaluate (multi-turn) → Create branch
  → Investigate → Code (iterative + CI) → Create PR → Post transcription
  → Acknowledge issue → Monitor issue comments → Monitor PR review comments
  → Analyze competing PRs → Optionally synthesize super PR
```

## Security Model

Argus operates under a zero-trust model. All user-generated content (issues, comments, PR descriptions) is treated as potentially adversarial. See [SECURITY.md](SECURITY.md) for the full 12-layer defense architecture.

## License

`SPDX-License-Identifier: Apache-2.0 OR MIT`

Dual-licensed under [Apache-2.0](LICENSE_APACHE2.TXT) or [MIT](LICENSE_MIT.TXT),
**at your option** — take the Apache-2.0 terms if you want its express patent
grant, MIT if you want the shorter text. You don't need to tell anyone which you
picked. See [LICENSE.txt](LICENSE.txt) for the full statement.

Contributions are dual-licensed the same way unless you say otherwise.
