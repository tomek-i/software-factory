# Security

## Supported versions

Only the latest release, or `main` before the first release, gets security fixes.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through [GitHub's private vulnerability reporting](https://github.com/tomek-i/software-factory/security/advisories/new) instead.

- Say what an attacker can do, how, and with which version or commit.
- A proof of concept helps. Please don't run it against anyone else's repository.
- You should hear back within a week. Once a fix ships, the advisory is published, with credit to you if you want it.

## How the factory protects you

The factory runs AI agents on issue text, and on a public repo anyone can write an issue. These are the safeguards. The [README](README.md) has the details.

**Who is trusted** ([Trusted authors](README.md#trusted-authors)):
- Only authors in `trust.authors` (and issues the factory wrote from your own idea) are treated as the spec.
- Anyone else's issue or comment is handled as untrusted data. A run on it always waits for you before anything is built, and the spec reaches the builder marked as untrusted.
- The factory only works on issues you start (`factory run`). Opening an issue does not start a run.

**What agents can do:**
- Each role runs with its own permission allowlist (`--permission-mode dontAsk`). Most roles have no shell and can write only their own report file.
- Agents ignore your Claude Code settings, hooks, plugins and MCP servers (`--setting-sources ""`, `--strict-mcp-config`).
- Agents run on your Claude subscription. `ANTHROPIC_API_KEY` is removed from their environment.
- The engine, not an agent, starts the app, drives the browser and records videos, and only on the app's own origin.

**What a branch cannot change:**
- Config, prompts, checks, the trust list and lessons are read from the default branch on GitHub, never from the run's own branch.
- Your checks run without `ANTHROPIC_API_KEY`, `GH_TOKEN` or `GITHUB_TOKEN`, and a secret scan runs on every checked commit.

**What always stops for you:**
- Hard rules: protected paths, new or changed dependencies, lockfiles, package-source config, `.env`, key and certificate files, and deletions the issue does not name. Only a per-run `--unsafe` flag lifts them, and it can never be set in config.
- The merge gate, by default. The factory merges only the exact commit that passed the gate (`gh pr merge --match-head-commit`).

## Out of scope

- Running a run with `--unsafe`, adding a hostile author to `trust.authors`, or setting `trust.everyone: true` on a public repo.
- Anything an agent does inside the permissions you gave it in your own prompt overrides (`.factory/prompts/`).
- Vulnerabilities in Claude Code, `gh`, Playwright or other tools the factory calls. Please report those to their maintainers.
