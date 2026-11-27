# Security

## Supported versions

Only the latest release, or `main` before the first release, gets security fixes.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through [GitHub's private vulnerability reporting](https://github.com/tomek-i/software-factory/security/advisories/new) instead.

- Say what an attacker can do, how, and with which version or commit.
- A proof of concept helps. Please don't run it against anyone else's repository.
- You should hear back within a week. Once a fix ships, the advisory is published, with credit to you if you want it.

## How the factory protects you

The factory runs AI agents on issue text, and on a public repo anyone can write an issue. These are the safeguards. The [README](README.md) and the [docs](docs/agent-permissions.md) have the details.

**Who is trusted** ([Trusted authors](docs/trust.md#trusted-authors)):
- Only authors in `trust.authors` (and issues the factory wrote from your own idea) are treated as the spec.
- Anyone else's issue or comment is handled as untrusted data. A run on it always waits for you before anything is built, and the spec reaches the builder marked as untrusted.
- The factory only works on issues you start (`factory run`). Opening an issue does not start a run.
- Review comments on a run's PR are untrusted data too. With `merge.open_feedback: fix` only threads by trusted authors and the apps in `merge.comment_bots` go to the builder without you; anyone else's always wait for you. Comments reach the builder framed as data ([Open review threads and failed checks](docs/pipeline.md#open-review-threads-and-failed-checks)).

**What agents can do:**
- Each role runs with its own permission allowlist (`--permission-mode dontAsk`). Most roles have no shell and can write only their own files in the run's folder.
- Agents ignore your Claude Code settings, hooks, plugins and MCP servers (`--setting-sources ""`, `--strict-mcp-config`).
- Agents run on your Claude subscription. `ANTHROPIC_API_KEY` is removed from their environment.
- The engine, not an agent, starts the app, drives the browser and records videos, and only on the app's own origin.
- The optional deep security scan ([Deep security scan](docs/pipeline.md#deep-security-scan)) runs the claude-security plugin's agents with no sandbox, in auto mode, as you. They get the agents' environment (no tokens, `gh` logged out) and your user settings, never the repo's. The scan never runs on a change built from an untrusted author's issue.

**What a branch cannot change:**
- Config, prompts, checks, the trust list, lessons and the `CLAUDE.md` given to agents are read from the default branch on GitHub, never from the run's own branch.
- Your checks run without `ANTHROPIC_API_KEY`, `GH_TOKEN` or `GITHUB_TOKEN`, and a secret scan runs on every checked commit.

**What an imported snapshot cannot do** ([Moving between machines](docs/moving-between-machines.md)):
- Make an issue trusted: a "the factory opened it" mark from the file counts only once GitHub says the factory's own gh login opened the issue.
- Supply an issue's text, author or link: an issue new to the database is filled in from GitHub, and fetched before a run uses it.
- Send escapes to your terminal: `factory import` shows control characters from the file as `[U+001B]`, in `--dry-run` too.
- `factory export` writes the file readable by you only, also when it overwrites one.

**What always stops for you:**
- Hard rules: protected paths, new dependencies or new dependency sources, any lockfile change, package-source config, `.env`, key and certificate files, and deletions the issue does not name. Only a per-run `--unsafe` flag lifts them, and it can never be set in config.
- The merge gate, by default. The factory merges only the exact commit that passed the gate (`gh pr merge --match-head-commit`).
- Unresolved review threads and failed checks on the PR, read again right before the merge, by default (`merge.open_feedback: ask`).

**The web app** (`factory serve`):
- It listens on 127.0.0.1 only, and refuses a request whose `Host` isn't its own address, so a web page can't reach it through DNS rebinding.
- Every API call needs the session token from the printed link, sent in a header, never a cookie (a browser would send a cookie to any server on 127.0.0.1). The link carries it after `#`, so it never reaches a server; it is new each start and compared in constant time. Which routes are open is decided on the route matched, not the raw URL.
- Changes need the server's own `Origin`, and its pages can't be framed, so another site can't make your browser approve or cancel a run. A decision names the state and gate the page showed, and is refused if the run has moved on.
- It offers the CLI's actions with the CLI's rules, and nothing more: no `--unsafe`, no config.

## Out of scope

- Running a run with `--unsafe`, adding a hostile author to `trust.authors`, or setting `trust.everyone: true` on a public repo.
- Anything an agent does inside the permissions you gave it in your own prompt overrides (`.factory/prompts/`).
- Vulnerabilities in Claude Code, `gh`, Playwright or other tools the factory calls. Please report those to their maintainers.
