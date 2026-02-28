# Contributing to MCP Ambassador Server

Thank you for your interest in contributing to MCP Ambassador Server. This repository is a pnpm monorepo containing 8 packages that work together to provide the MCP Ambassador backend services. Before opening issues or PRs, please take a moment to read this guide and the linked project documentation.

See the architecture documentation for an overview of how the packages interact: mcpambassador_docs/architecture.md

## Code of Conduct
Please follow the project's Code of Conduct: see CODE_OF_CONDUCT.md

## Security Vulnerabilities
Do NOT open public issues for security vulnerabilities. See .github/SECURITY.md for how to report vulnerabilities privately and securely.

## Quick Start

Prerequisites

- Node 20.x (we test on Node 20 and Node 22)
- pnpm 8.15.x (the repo uses pnpm workspaces)
- Docker / Docker Compose (optional, for local container validation)

Clone and install

```bash
git clone git@github.com:mcpambassador/server.git
cd server
pnpm install
```

Build and run tests locally

```bash
pnpm -r build        # compile all packages
pnpm -r lint         # run ESLint
pnpm format          # ensure files are formatted
pnpm format:check    # verify formatting
pnpm -r typecheck    # run TypeScript type checks
pnpm -r test         # run tests
```

If you need to run the server in containers for local integration testing:

```bash
docker compose up --build
```

## Repository Structure

This monorepo contains the following packages:

| Package | Description |
|---|---|
| packages/core | Core utilities and shared helpers used across packages |
| packages/protocol | Protocol definitions and wire formats |
| packages/contracts | Shared TypeScript contract types and interfaces |
| packages/authn-ephemeral | Ephemeral authentication helpers and short-lived credential flows |
| packages/authz-local | Local authorization policies and enforcement |
| packages/audit-file | File-backed audit log adapter for local deployments |
| packages/server | The HTTP API server and runtime integration code |
| packages/spa | Static single-page application assets served by the server |

## How to Contribute

### Reporting Bugs

Please use the bug report template when opening an issue. Include the following where possible:

- Version (git tag or commit SHA)
- Steps to reproduce
- Expected behavior
- Actual behavior and any error messages or logs

### Suggesting Features

Open an issue to discuss the proposal before starting work. For changes that cross package boundaries or change API contracts, an Architecture Decision Record (ADR) may be required — see mcpambassador_docs/adr/ for the ADR process.

### Submitting Changes

1. Fork the repository and clone your fork
2. Create a new branch using the pattern: feat/, fix/, docs/, chore/ followed by a short description
3. Make your changes and ensure code follows the coding standards below
4. Run the CI gate locally before creating a PR:

```bash
pnpm -r build
pnpm -r lint
pnpm format:check
pnpm -r typecheck
pnpm -r test
```

5. Push your branch and open a pull request against main

### What to Expect from Automation

When you open an issue:

- The needs-triage label is added automatically
- An acknowledgment comment is posted
- Keywords in the issue body may auto-label (bug, enhancement, security, etc.)

When you open a pull request:

- Labels are added automatically based on files changed (for example: area: core, area: spa)
- Reviewers are auto-assigned
- If authentication, cryptography, or schema files changed a security-review-required label is added (this is expected)
- CI runs a set of checks: build, lint, typecheck, and tests (on Node 20 and Node 22)
- Security audit and secret scanning run for dependency changes
- Docker build validation runs on Dockerfile changes
- PRs with no activity for 14+ days are marked stale; 21+ days are auto-closed

## CI Requirements

All pull requests must pass the following commands locally and in CI before they can be merged:

```bash
pnpm -r build
pnpm -r lint
pnpm format:check
pnpm -r typecheck
pnpm -r test
```

Note: CI runs on both Node 20 and Node 22. Do not use APIs added after Node 20.

## Coding Standards

### TypeScript

- The repository is compiled with strict TypeScript options
- Avoid using `any` without a clear eslint-disable comment and justification
- Use Zod for all public input validation
- Return errors in the canonical format: { error: { code, message } }

### Formatting & Linting

- Prettier is the canonical formatter. Run `pnpm format` before committing changes.
- ESLint uses a flat config (eslint.config.js) in the repo root

### Testing

- Vitest is used for unit and integration tests
- Test files should end with `.test.ts`
- Unit tests should mock external dependencies
- Integration tests should use an in-memory SQLite database when possible

### Commit Messages

We recommend using Conventional Commit prefixes (feat:, fix:, docs:, chore:), but this is not strictly enforced by automation.

## Security-Sensitive Areas

Changes to the following paths will trigger an automatic security review and should include extra care in PR descriptions:

- packages/server/src/auth/ (authentication flows)
- packages/core/src/schema/ (database schema and migrations)
- packages/server/src/services/credential-vault* (cryptography and secrets handling)
- Dockerfile, docker-compose.yml (container configuration)

## Review Process

- Maintainers aim to respond within 7 business days for bug fixes and 14 business days for new features
- Registry or documentation-only PRs are typically reviewed within 3-5 business days
- MCP Ambassador is maintained primarily by one person with AI assistance; please be patient for reviews
- If your PR is idle for more than 2 weeks, a polite ping in the PR thread is appropriate

## AI-Assisted Contributions

AI-assisted contributions are welcome. This repository includes .github/copilot-instructions.md which defines repository-specific guidance for GitHub Copilot and compatible tools. Please review that file before submitting AI-assisted code.

## Getting Help

If you need help, open an issue describing the problem or question, or consult the project documentation at https://docs.mcpambassador.dev.

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
