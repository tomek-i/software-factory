# Software Factory

An AI software factory that turns GitHub issues (or a free-text idea) into reviewed, tested, demo'd pull requests, driven by headless Claude Code on your own Claude subscription.

It runs in two modes on one engine:

- **CLI mode**: install into a single repo and drive it from the terminal.
- **Web mode** *(planned)*: a local dashboard that manages several repos, syncs GitHub issues both ways and runs issues in parallel.

> Status: early development. A queued issue can run through triage, build, the quality gate loop and parallel reviews to a draft PR (`factory run`). Refine, spec critic, verifying review findings, capture and merge are not automated yet: a reviewed run waits for you at the `review` gate.

## Pipeline

```
issue writer → triage → (refine) → spec critic → build → quality gate ⟲ → parallel reviews ⟲
            → capture (screenshots + walkthrough) → PR → merge decision → learn
```

- **Gates** after issue writer, triage, critic, plan, review, PR and merge each have a mode: `always` (pass through), `auto` (the agent decides or escalates with reasons) or `human` (always stop for you).
- **Loops** (failed checks, confirmed review findings) always go back to the builder, up to a cap, then escalate to you. A loop that fails the same way twice in a row escalates early, so a stuck builder does not use up the cap.
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
- creates GitHub status labels only if you enabled `github.status_labels` (off by default; see below).

It is safe to re-run. An existing config is never overwritten.

### Choosing what the factory works on

Work is picked **locally**, never from GitHub labels, so nobody on GitHub can feed issues into your factory.

```sh
factory sync               # pull open issues from GitHub into .factory/factory.db
factory issues             # list them (Q marks queued issues); --queued, --all
factory queue 12 15 18     # queue issues for the factory (fetches unsynced ones)
factory unqueue 15         # take one back out
```

Issues closed on GitHub drop out of the queue on the next sync.

### Running an issue

```sh
factory run 12             # run issue #12 until it needs you (syncs and queues it first if needed); --unsafe lifts hard rules for this run only
factory status             # active runs: state, round, cost, waiting gate; --all includes finished ones
factory logs 12            # events and agent log excerpts; -f follows a running run
factory show 12            # overview: state, gate, branch, PR, verdict summaries, files in the run folder
factory show 12 triage     # one file in full: triage, build, checks (latest round) or a path like round-2/checks.md
factory approve <run>      # let a run waiting at a gate continue and keep running it; -m "why", --no-run to only record it
factory reject <run> -m "why"   # end a run waiting at a gate
factory resume <run> --to build -m "why"   # send an escalated run back to a stage and keep running it; --reset-loops, --no-run
factory cancel <run>       # stop the run, its agent and running checks; the worktree is kept
```

`factory run <n>` is enough for a brand-new issue: running it is your decision to work on it, so if the issue isn't queued yet it fetches it fresh from GitHub and queues it, the same as `factory queue <n>`. Closed issues are refused, and an issue by an author outside `trust.authors` still waits for you at triage. `factory approve` and `factory resume` carry on driving the run in the same terminal, as `factory run` would; with `--no-run` they only record the decision.

`<run>` is a run id, a unique prefix of one, or an issue number (`12`) for that issue's latest run. `#12` works too, but PowerShell reads `#` as the start of a comment, so quote it there (`'#12'`).

What `factory run` does today:

1. **Triage**: an agent with no shell reads the issue and the code and writes `triage.md` (`APPROVE`, `REJECT` or `NEEDS_INFO`). Rejections and questions are posted on the issue. The `triage` gate then decides whether to continue. After the author answers, `factory run` again triages the issue again (run `factory sync` first so it sees an edited issue).
2. **Build**: a builder agent works in its own worktree (`.worktrees/<run>`, branch `factory/<issue>-<slug>`, created from the latest `origin/<default branch>`) and commits. It cannot push. The engine scans every new commit for secrets (gitleaks if installed, otherwise built-in patterns) and sends the builder back if it finds one, so a leaked key never reaches GitHub. Then the engine pushes the branch (never forced) and opens a **draft** PR that closes the issue. Its description starts with a short brief for you (What, How it was tested), with the builder's implementation notes collapsed underneath.
3. **Quality gate**: the engine runs your `checks` on the pushed commit, plus the secret scan again. Checks run without `ANTHROPIC_API_KEY`, `GH_TOKEN` or `GITHUB_TOKEN` in their environment. On failure the builder gets the report and tries again, up to `loops.max_build_iterations`, then the run waits for you. If two rounds in a row fail the same way (same failed checks with the same output and exit code, and the same secret-scan hits, ignoring timings, commit shas and the worktree path), the run stops before the cap and waits for you.
4. **Reviews**: on a pass, reviewer agents look at the commit the gate passed, all at the same time, each through one lens: `reviews.always` (default code, security, docs) every time, plus `reviews.ui` (default ux, ui) when triage listed `ui` in SURFACES. Each lens has its own model and effort (`models.reviews`). They can read the code and run `git diff`, `git log` and `git show`, and write `round-N/review-<lens>.md` with `VERDICT: PASS | CHANGES` and findings rated critical, major, minor or nit. Only critical and major findings count against a change; minor ones and nits never hold the run up. If your usage limit is hit mid-review, `factory run` later only runs the lenses that have not written a review yet.
5. The run then waits at the `review` gate with each lens's verdict in the reason, e.g. `reviews: code CHANGES (1 blocking), security PASS, docs PASS`. `factory show <run>` lists each review's summary and blocking findings. Verifying findings is not automated yet, so a blocking finding always waits for you: send the run back with `factory resume <run> --to build -m "fix …"`, or approve it as is. Approving the review gate moves the run to capture, which is not automated yet: mark the draft PR ready and merge it yourself. If the branch trips a hard rule, the reason lists each hit, for example `protected path (infra/**): infra/main.tf` or `new dependency in package.json: left-pad`. They are read from the git diff of the checked commit against where the branch left the default branch, fetched fresh from GitHub (so a builder cannot move the base): changes under protected paths; new dependencies or a dependency pointed at a new source (git, URL, `npm:` alias, override, Go `replace`) in package.json, .csproj/Directory.Packages.props, requirements*.txt, pyproject.toml, Pipfile or go.mod; any lockfile change; changes to package-source config such as `.npmrc`, `pnpm-workspace.yaml`, `NuGet.Config`, `Directory.Build.props` or `.gitmodules`; `.env*`, key, certificate and `.tfvars` files; and deleted files the issue and triage don't name by their path (a rename counts as a deletion). A run started with `--unsafe` still lists them, marked as lifted, and its PR description opens with a warning. Protected paths in `hard_rules.paths` are repo-relative globs using only `*`, `**` and `?`; anything else is rejected when the config loads.

When a run escalates (agent failed, builder blocked, loop cap reached, loop stalled), `factory run` tells you why; a stall names both rounds, for example `stalled: quality gate failed the same way in rounds 2 and 3 (see round-2/checks.md and round-3/checks.md)`. Send it on with `factory resume` or stop it with `factory cancel`. After a resume, stall detection starts afresh (with or without `--reset-loops`): only two more identical failures in a row stop the run again. If your Claude usage limit is hit, the run stops where it is; run `factory run` again after the reset and it continues the same agent session. A malformed agent hand-over gets one retry with the problems listed, then the run waits for you.

Run artifacts (issue, triage, build report, `round-N/checks.md` and `checks.log`, `round-N/review-<lens>.md`, agent prompts, permission profiles and full stream logs) are in `.factory/runs/<run>/`. `factory show <run>` summarises them and `factory show <run> <file>` prints one; when a run waits at a gate, `factory run` names the file to read, for example `factory show <run> build` at the `review` gate.

**What steers the agents is read from the default branch.** `factory run` reads `.factory/config.yaml`, `.factory/prompts/<role>.md` and `.factory/lessons.md` from `origin/<default branch>`, not from your working copy, so a checked-out branch cannot change its own checks, trust list, gates or prompts. Commit and push config changes before they take effect.

**Agent permissions.** Agents run with `--permission-mode dontAsk` and a per-role allowlist (in `.factory/runs/<run>/agent/`), and ignore your own Claude Code settings, hooks and MCP servers (`--setting-sources ""`, `--strict-mcp-config`) so nothing outside the profile applies to an agent reading issue text. Triage can read the repo and write only its run folder. Reviewers can read the repo, write only their run folder and run only `git diff`, `git log` and `git show`; their prompt is `.factory/prompts/reviewer.md` plus `review-<lens>.md`. The builder can edit and use Bash but is denied `git push`, `gh pr`, `gh api` and edits to `.factory/`. Bash deny rules are prefix matches, so also protect your default branch on GitHub.

### Trusted authors

Anyone who can open an issue can write text the agents will read, so the factory distinguishes trusted authors:

```yaml
trust:
  authors: ["your-handle", "teammate"]   # init pre-fills your own gh login
  everyone: false                        # true for private repos where only approved people open issues
```

- **Trusted** issues and comments are treated as the spec.
- **Untrusted** ones (e.g. strangers on a public repo) can still be queued, but their text is handled as untrusted data and triage always waits for your approval before anything is built. `factory issues` marks them `(untrusted)`.

**Status labels (optional).** With `github.status_labels: true`, the factory mirrors run status onto the issue (`factory`, `factory:in-progress`, `factory:needs-info`, `factory:needs-human`, `factory:unsafe`). They are display-only and never read as input. Run `factory init` again after enabling them to create the labels.

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
| `models` | Model and effort per agent role and review lens, with overrides when triage rates the risk HIGH |
| `trust` | Whose issues and comments count as the spec |
| `github` | Optional status labels, sync interval, daily start limit |

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
packages/core     engine: config, SQLite store, state machine, gates, agent runner, prompts,
                  worktrees, quality gate, pipeline driver, init, GitHub issue sync
  prompts/        shipped role prompts (override per repo in .factory/prompts/<role>.md)
  test/           fake `claude` binary and fixtures: tests never spend real usage
packages/shared   zod schemas shared by everything (config, run states, agent verdicts)
```
