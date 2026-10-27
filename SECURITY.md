# Security Policy

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability in Argus, please report it responsibly.

### How to Report

1. **Do NOT** open a public GitHub issue for security vulnerabilities
2. Email the maintainers directly with details of the vulnerability
3. Include as much information as possible:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

### What to Expect

- We will do our best to acknowledge receipt within 48 hours
- We will do our best to investigate and provide updates on the fix timeline
- We will credit you in the security advisory (unless you prefer to remain anonymous)

## Security Model

Argus reads text written by anyone who can open an issue or comment, then writes code and posts to your repositories. Everything below assumes that text is hostile.

### Who can make Argus write code

Nobody untrusted. Code generation runs only for issues opened by a trusted user (`argus.trust.trustedUsers`, or an owner/member/collaborator per the `argus.trust.*` settings), or after a trusted user comments `/argus fix`. Trust comes from the forge's own association data, not from anything in the comment text. Everyone else's issues are triaged and labelled, nothing more.

### Defenses

| Defense | What it does |
|---|---|
| **Fail-closed decisions** | A model error, refusal, missing canary or unparseable reply never counts as "accept" or "pass". Evaluations go to human review; the merge gate posts `failure`. |
| **Input sanitization** | Issue and comment text is length-limited (`argus.security.maxInputLength`), stripped of fake boundary markers, and invisible characters are revealed before the model sees it. |
| **Framing** | Untrusted text is wrapped in random per-request boundaries, and replies must echo a random canary inside the JSON. Every model call is stateless — no conversation is shared between issues. |
| **Code containment** | The coder may only write files it read in full (or new files it planned). Execution-surface paths — CI config, `.github/`, manifests, lockfiles, build scripts, hooks, Dockerfiles, credentials — are rejected at any depth. Added lines that execute processes, evaluate code or make network calls are rejected. Changes are capped by `argus.maxDiffLines` and committed atomically. |
| **Bait-and-switch detection** | If the issue body changes after evaluation, Argus stops before opening a PR and labels it `subversion-detected`. |
| **Merge gate** | Every open PR, Argus's own included, gets an `argus/threat-assessment` commit status from a diff review. Unavailable or uncertain assessments are `failure` ("human review required"). |
| **Moderation** | Pattern matches only flag. Deleting a comment needs model confirmation above `argus.security.threatThreshold`; blocking additionally needs `argus.security.autoBlock` (off by default) and is capped by `argus.rateLimits.blocksPerDay`. Hostile text is never quoted back. |
| **Signed output** | Everything Argus posts carries an HMAC-SHA256 stamp bound to the artifact it was posted on. Argus only treats verified stamps as its own, so pasted or copied stamps are ignored. Keys rotate (`argus.crypto.keyRotationDays`) and old stamps still verify. |
| **Multiple instances** | An issue already claimed by another Argus instance (posting from an account with write access) is left alone. |
| **Audit log** | Actions are recorded in a hash-chained, signed log (bounded, with a signed checkpoint). **Argus: Verify Audit Log** checks it. |
| **Guarded writes** | Every GitHub/GitLab write goes through one wrapper that enforces dry run, Emergency Stop, the `argus.rateLimits.*` caps and outbound redaction. No component can bypass it. |
| **Watchdog** | Work on one issue is aborted after `argus.watchdogTimeoutMinutes`. |
| **Settings scope** | All Argus settings are application-scoped, so a cloned repository's `.vscode/settings.json` can't redirect API keys or turn off dry run. |
| **Webviews** | Settings pages run under a strict nonce-based Content Security Policy, receive data only via messages, and every message back is validated. |

### Known limits

- Token scope can't be enforced by Argus. Use a fine-grained token limited to the repositories you watch, with only the permissions in the README.
- The merge gate and moderation rely on a model's judgement. They reduce risk; they don't replace human review.
- Pushing a branch to your repository runs your CI with your secrets. That is why only trusted users can trigger code generation.
- With the `claude-code` provider, the Claude Code CLI tells the model your account email and some machine details. Argus redacts them from replies and from everything it posts.

## Supported Versions

As this project is in early development, only the latest version is supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| 0.x.x   | :white_check_mark: |

## Security Best Practices

When using Argus:

1. **PAT Tokens**: Never commit GitHub/GitLab tokens to the repository. Argus stores them in VS Code SecretStorage.
2. **Audit Trail**: Review the cryptographic audit log periodically for unexpected actions.
3. **Start in dry run**: Turn on `argus.dryRun` until you are comfortable with what Argus would do. Keep `argus.trust.trustedUsers` short.
4. **Dependencies**: Keep dependencies up to date.
5. **Never Merges**: Argus never merges its own PRs. A human must always approve and merge.
