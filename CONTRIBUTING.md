# Contributing to Argus

Welcome to Argus! We're excited that you're interested in contributing. This document provides guidelines and information about contributing to this project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [How to Contribute](#how-to-contribute)
- [Development Setup](#development-setup)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Commit Messages](#commit-messages)
- [License](#license)

## Code of Conduct

Please review our [Code of Conduct](CODE_OF_CONDUCT.md) before contributing.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR-USERNAME/argus.git
   cd argus
   ```
3. **Add the upstream remote**:
   ```bash
   git remote add upstream https://github.com/accesspointmg/argus.git
   ```
4. **Create a branch from `development`** for your work:
   ```bash
   git fetch upstream
   git checkout -b feature/your-feature-name upstream/development
   ```

> **Branches:** all pull requests target `development`. `main` holds released
> code and only accepts merges from `development`; PRs opened against `main`
> fail the branch-policy check.

## How to Contribute

### Reporting Bugs

- Check if the bug has already been reported in [Issues](https://github.com/accesspointmg/argus/issues)
- If not, create a new issue using the Bug Report template
- Provide as much detail as possible

### Suggesting Features

- Check existing issues and discussions for similar suggestions
- Create a new issue using the Feature Request template
- Describe the feature and its use case

### Code Contributions

1. Find an issue to work on, or create one
2. Comment on the issue to let others know you're working on it
3. Follow the development setup and coding standards below
4. Submit a pull request

## Development Setup

### Prerequisites

- Node.js 18+
- VS Code 1.95+
- Git

### Installation

```bash
# Clone the repo
git clone https://github.com/YOUR-USERNAME/argus.git
cd argus

# Install dependencies
npm install

# Compile TypeScript
npx tsc

# Launch Extension Development Host
# Press F5 in VS Code, or run:
code --extensionDevelopmentPath=.
```

### Running Tests

```bash
# Compile first
npx tsc

# Run tests (requires VS Code test runner)
npm test
```

## Pull Request Process

1. **Update your branch** with the latest upstream changes:
   ```bash
   git fetch upstream
   git rebase upstream/development
   ```

2. **Ensure the project compiles cleanly**:
   ```bash
   npx tsc --noEmit
   ```

3. **Add tests** for new functionality

4. **Update documentation** if needed

5. **Sign your commits** using the DCO (Developer Certificate of Origin):
   ```bash
   git commit -s -m "Your commit message"
   ```

6. **Push your branch** and open a pull request **against `development`**:
   ```bash
   git push origin feature/your-feature-name
   ```

7. **Fill out the PR template** completely

8. **Address review feedback** promptly

## Coding Standards

### TypeScript Style

- Use strict TypeScript (`"strict": true`)
- Use type annotations for function parameters and return values
- Maximum line length: 120 characters
- Use meaningful variable and function names
- Prefer `const` over `let`; avoid `var`

### Code Organization

- Keep functions focused and small
- Write JSDoc comments for public functions and classes
- Organize imports: node builtins, `vscode`, third-party, local

### Example

```typescript
/**
 * Parse a repository input string into a structured config.
 *
 * Accepts HTTPS URLs, SSH URLs, `platform:owner/repo`, or bare `owner/repo`.
 *
 * @param raw - The raw input string from the user.
 * @returns A parsed RepoConfig, or undefined if the input is invalid.
 */
export function parseRepoInput(raw: string): RepoConfig | undefined {
    const trimmed = raw.trim();
    if (!trimmed) {
        return undefined;
    }
    // ...
}
```

## Commit Messages

Follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Code style (formatting, semicolons, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

### Examples

```
feat(forge): add GitLab merge request support
fix(security): handle malformed nonce in replay check
docs(readme): update installation instructions
```

## Developer Certificate of Origin (DCO)

All commits require the DCO sign-off. This certifies that you have the right to submit the code under the project's license.

Sign your commits with:
```bash
git commit -s -m "Your commit message"
```

This adds a `Signed-off-by` line to your commit message.

## License

By contributing to Argus, you agree that your contributions will be licensed under the project's dual Apache 2.0 / MIT license.

## Questions?

Feel free to open a [Discussion](https://github.com/accesspointmg/argus/discussions) or reach out to the maintainers.

Thank you for contributing!
