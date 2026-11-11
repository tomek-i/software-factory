# Software Factory

An AI software factory that turns GitHub issues (or a free-text idea) into reviewed, tested, demo'd pull requests, driven by headless Claude Code on your own Claude subscription.

It runs in two modes on one engine:

- **CLI mode**: install into a single repo and drive it from the terminal.
- **Web mode** *(planned)*: a local dashboard that manages several repos, syncs GitHub issues both ways and runs issues in parallel.

> Status: early development. Phase 1 (foundation + `factory init`) is in place. The pipeline itself is not wired up yet.

## Pipeline

```
issue writer → triage → (refine) → spec critic → build → quality gate ⟲ → parallel reviews ⟲
            → capture (screenshots + walkthrough) → PR → merge decision → learn
```

- **Gates** after issue writer, triage, critic, plan, review, PR and merge each have a mode: `always` (pass through), `auto` (the agent decides or escalates with reasons) or `human` (always stop for you).
- **Loops** (failed checks, confirmed review findings) always go back to the builder, up to a cap, then escalate to you.
- **Hard rules** (protected paths, new dependencies, secret/env changes) always escalate to you, whatever the gate mode. Only a per-run `--unsafe` flag lifts them, and it can never be set in config.
- **State changes need evidence**: for example, reviews only start when the commit that passed the quality gate is the branch's current HEAD.

## Requirements

- Node.js 22+ and pnpm
- Git
- GitHub CLI (`gh`), logged in
- Claude Code (`claude`), logged in with your subscription. The factory removes `ANTHROPIC_API_KEY` from the agents' environment so runs use your subscription, not API billing.

## Usage

```sh
pnpm install
pnpm build

# in the repo you want to use the factory on
node <path-to-this-repo>/apps/cli/dist/main.js init
```

`factory init`:

- detects your stack (Node, .NET, Python, Go) and writes `.factory/config.yaml` with check commands. Review and commit it.
- writes `.factory/lessons.md`, which agents read before every run.
- adds runtime state (`.factory/runs/`, `.factory/factory.db*`, `.worktrees/`) to `.gitignore`.
- registers the project in `.factory/factory.db`.
- creates the `factory`, `factory:in-progress`, `factory:needs-info`, `factory:needs-human` and `factory:unsafe` labels on GitHub (skip with `--no-labels`).

It is safe to re-run. An existing config is never overwritten.

## Configuration

See the comments in the generated `.factory/config.yaml`. The main sections:

| Key | Purpose |
|---|---|
| `checks` | Commands that must all pass before reviews start |
| `app` | How to start the app for screenshots and videos |
| `gates` | `always` / `auto` / `human` per gate |
| `hard_rules` | Paths and triggers that always escalate to a human |
| `loops` | Caps for build iterations, review rounds and spec critic rounds |
| `reviews` | Which review lenses run always and which only for UI changes |
| `models` | Default model and per-role overrides |

## Development

```sh
pnpm test        # vitest
pnpm typecheck   # tsc, including tests
pnpm lint        # eslint
pnpm build       # tsc -b
pnpm factory init   # run the CLI from source
```

Layout:

```
apps/cli          the `factory` command
packages/core     engine: config, SQLite store, state machine, gates, init
packages/shared   zod schemas shared by everything (config, run states, agent verdicts)
```
