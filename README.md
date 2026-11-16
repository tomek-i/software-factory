# Software Factory

[![CI](https://github.com/tomek-i/software-factory/actions/workflows/ci.yml/badge.svg)](https://github.com/tomek-i/software-factory/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/tomek-i/software-factory?sort=semver)](https://github.com/tomek-i/software-factory/releases/latest) [![License: PolyForm Noncommercial](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](LICENSE)

Give it a GitHub issue, or just an idea. Get back a reviewed, tested pull request.

- **You give it:** a GitHub issue, or a free-text idea that `factory new` turns into one.
- **You get back:** a pull request that passed your checks and several AI reviews. For a UI change it comes with before/after screenshots and a narrated walkthrough video.
- **It runs on:** headless Claude Code with your own Claude subscription, not API billing.
- **You stay in charge:** by default it waits for you before it merges.

It runs in two modes on one engine:

- **CLI mode**: install into a single repo and drive it from the terminal.
- **Web mode**: `factory serve` opens a local web app over every registered repo: queue issues, watch runs going on in parallel, and decide at gates (see [Web mode](docs/web-mode.md)).

> **Status: early development.** What works today:
>
> - `factory new` drafts issues from an idea.
> - `factory run` takes a queued issue all the way to a merged PR (see [Pipeline](#pipeline)).
> - After the merge, a learner proposes lessons for you to approve (`factory lessons`).
> - By default the run waits for you at the `merge` gate.
> - `factory work` and `factory serve` work through every registered repo's queue; `factory serve` adds a local web app to queue issues, watch runs and decide at gates.

## Pipeline

```mermaid
flowchart TD
    idea(["Idea"]) -->|"factory new"| writer["Issue writer"]
    writer --> triage["Triage"]
    queued(["Queued issue"]) -->|"factory run"| triage
    triage -->|"INCOMPLETE"| refine["Refine"]
    triage -->|"READY"| critic["Spec critic"]
    refine --> critic
    critic -->|"REVISE"| refine
    critic -->|"ACCEPT"| build["Build"]
    build --> gate["Quality gate"]
    gate -->|"failed checks"| build
    gate -->|"pass"| reviews["Parallel reviews"]
    reviews -->|"changes asked"| verifier["Verifier"]
    verifier -->|"confirmed findings"| build
    verifier -->|"all refuted"| capture["Capture"]
    reviews -->|"clear"| capture
    capture --> pr["PR"]
    pr --> resync["Re-sync"]
    resync -->|"conflict or failed re-check"| build
    resync --> mergegate["Merge gate"]
    mergegate --> merge["Merge"]
    merge --> learn["Learn"]
    learn --> done(["Done: merged"])

    triage -->|"NEEDS_INFO"| ask{{"Asks the author"}}
    critic -->|"questions"| ask
    ask -->|"author answers"| triage

    writer & triage & critic & gate & reviews & pr & mergegate -.-> you{{"Waits for you"}}
    you -->|"factory reject"| rejected(["Rejected"])
    you -->|"factory cancel"| cancelled(["Cancelled"])
    triage -->|"REJECT"| rejected
    critic -->|"REJECT"| rejected

    classDef human fill:#fde68a,stroke:#b45309,color:#000
    classDef final fill:#e5e7eb,stroke:#374151,color:#000
    class ask,you human
    class done,rejected,cancelled final
```

Yellow hexagons are where the run stops for a person.
Dotted lines show where it can wait for you: a gate in `human` mode, a hard-rule hit, a loop cap or a stall.

Triage reads the issue and decides whether to build it; refine fills in what an incomplete issue leaves open, and the spec critic checks the spec against the code.
A builder then commits in its own worktree, the quality gate runs your checks, and reviewers look at the change through several lenses, with a verifier checking their findings.
For a UI change, capture adds screenshots and a video to the PR.
The branch is re-synced with the default branch, the merge gate decides, and the engine merges; a learner then proposes lessons.
Failures loop back to an earlier stage up to a cap, and gates, hard rules and loop caps stop for you.
Every stage, gate and loop is described in [docs/pipeline.md](docs/pipeline.md).

## Requirements

- Node.js 22.12+ and pnpm
- Git
- GitHub CLI (`gh`) 2.50 or newer, logged in
- Claude Code (`claude`), logged in with your subscription.
  - The factory removes `ANTHROPIC_API_KEY` from the agents' environment, so runs use your subscription, not API billing.
  - It also keeps your GitHub login away from agents (see [Agent permissions](docs/agent-permissions.md)).
- Optional, for screenshots and videos of UI changes: Playwright's Chromium.
  See [Capture: Requirements](docs/capture.md#requirements).
- Optional, so everyone can see the screenshots and videos in the factory's PRs: run `factory login github` once.
  See [Where the media goes](docs/capture.md#where-the-media-goes).
- Optional, for a narrated walkthrough: the narrate Claude Code plugin and `ffmpeg` on PATH.
  See [Narrated walkthrough](docs/capture.md#narrated-walkthrough).

## Usage

```sh
pnpm install
pnpm build
pnpm add -g "$(pwd)/apps/cli"   # puts `factory` on your PATH

# in the repo you want to use the factory on
factory init
```

- Run it from this repo's root.
- It needs pnpm's global bin folder on your `PATH`: if `pnpm add -g` complains, run `pnpm setup` once and open a new shell.
- `pnpm add -g` links the checkout rather than copying it, so a later `pnpm build` updates the global `factory`.
- `pnpm remove -g @factory/cli` takes it off again.
- `pnpm -C <path-to-this-repo> factory` is not a substitute.
  pnpm runs the script in the factory's own folder, and the CLI acts on its working directory, so it would always act on this repo.

`factory init`:

- detects your stack (Node, .NET, Python, Go) and writes `.factory/config.yaml` with check commands. Review and commit it.
- writes `.factory/lessons.md`, which agents read before every run.
- adds runtime state (`.factory/runs/`, `.factory/factory.db*`, `.worktrees/`, `.factory/drafts/`) to `.gitignore`.
- registers the project in `.factory/factory.db`.
- adds the repo to your project list (see [The project list](docs/worker.md#the-project-list)).
- creates GitHub status labels only if you enabled `github.status_labels` (off by default; see [Status labels](docs/trust.md#status-labels)).

It is safe to re-run. An existing config is never overwritten.

## Commands

### Writing issues from an idea

```sh
factory new "export orders as CSV"   # draft an issue from an idea
factory new --list                   # drafts waiting for you
factory new --approve <draft>        # create a draft on GitHub, sync it and queue it
factory new --discard <draft>        # drop a draft
```

How the issue writer and its gate work: [factory new](docs/factory-new.md).

### Choosing what the factory works on

```sh
factory sync               # pull open issues from GitHub into .factory/factory.db; finishes runs whose PR was merged or closed
factory issues             # list them (Q marks queued issues); -q/--queued, -a/--all
factory queue 12 15 18     # queue issues for the factory (fetches unsynced ones)
factory unqueue 15         # take one back out
```

How work is picked: [Worker](docs/worker.md#choosing-what-the-factory-works-on).

### Working through the queue

```sh
factory work               # work through the queues of every registered project until stopped; --max-runs <n> (default 3)
factory stop               # ask running workers (`factory work`, `factory serve`) to start no more runs, finish the ones going on, and exit
factory stop --now         # ask them to interrupt their runs instead and exit; the runs can be continued
```

The project list, what the worker picks and its limits: [Worker](docs/worker.md).

### Web mode

```sh
factory serve              # the web app on http://127.0.0.1:4180, plus the worker of `factory work`
factory serve --port 4181 --max-runs 2 --no-open
```

The screens and the security rules: [Web mode](docs/web-mode.md).

### Running an issue

```sh
factory run 12             # run issue #12 until it needs you (syncs and queues it first if needed); --unsafe lifts hard rules for this run only
factory run 12 15          # run several issues at once, up to concurrency.max_runs; each line is prefixed [#12], [#15]
factory status             # active runs: state, round, cost, waiting gate; -a/--all includes finished ones (finishes merged runs first); notes lessons waiting for you
factory logs 12            # events and agent log excerpts; -f/--follow follows a running run
factory show 12            # overview: state, gate, branch, PR, verdict summaries, files in the run folder
factory show 12 triage     # one file in full: triage, refine and critic (latest spec round), build, checks or capture (latest round), approval, learn, or a path like round-2/checks.md
factory approve <run>      # let a run waiting at a gate continue and keep running it; -m "why", --no-run to only record it
factory reject <run> -m "why"   # end a run waiting at a gate
factory resume <run> --to build -m "why"   # send an escalated run back to a stage and keep running it; --reset-loops, --no-run
factory cancel <run>       # stop the run, its agent and running checks; -m "why" is optional (see Cleaning up finished runs)
factory cleanup            # remove the worktrees and branches finished runs left behind; --dry-run lists them first
factory lessons            # lessons the learner proposed, waiting for you; -a/--all includes approved and rejected ones
factory lessons approve 3 4        # open one PR that appends these lessons to .factory/lessons.md
factory lessons reject 5 -m "why"  # never apply this lesson; -m is optional
```

More on runs:

- [Running an issue](docs/running.md): starting runs, approving, naming a run, merging on GitHub, cleanup and escalations.
- [Pipeline](docs/pipeline.md): what `factory run` does, stage by stage.
- [Run artifacts](docs/run-artifacts.md): the files a run writes.
- [Lessons](docs/lessons.md): approving and rejecting lessons.

## Documentation

- [Pipeline](docs/pipeline.md): the general rules and every stage.
- [Running an issue](docs/running.md): starting, steering and finishing runs.
- [Worker](docs/worker.md): the project list and `factory work`.
- [Web mode](docs/web-mode.md): `factory serve`.
- [factory new](docs/factory-new.md): writing issues from an idea.
- [Agent permissions](docs/agent-permissions.md): what each role may read and write.
- [Run artifacts](docs/run-artifacts.md): the files in a run's folder.
- [Trust](docs/trust.md): trusted authors and status labels.
- [Lessons](docs/lessons.md): how lessons are proposed and approved.
- [Capture](docs/capture.md): screenshots, videos and where they are hosted.
- [Repository settings](docs/repo-settings.md): how this repo protects `main`.

## Configuration

See the comments in the generated `.factory/config.yaml`. The main sections:

| Key | Purpose |
|---|---|
| `project` | `name` and `default_branch` (default `main`), the branch the factory builds from and reads its config from |
| `checks` | Commands that must all pass before reviews start |
| `app` | How to start the app for screenshots and videos: `start` (a shell command run in the worktree; unset means no capture), `url` (must contain `{port}`, which is filled in; default `http://localhost:{port}`), `port_env` (the variable that carries the port, default `PORT`), `ready_timeout_sec` (how long `url` may take to answer, default 180), `narrate` (`auto`, `off` or a path to narrate.mjs, see [Narrated walkthrough](docs/capture.md#narrated-walkthrough)) and `env` (names of variables to pass from your environment to the app, which otherwise gets only a minimal one; tokens are never passed) |
| `gates` | `always` / `auto` / `human` per gate (see [Pipeline: General rules](docs/pipeline.md#general-rules) for the defaults) |
| `hard_rules` | Paths and triggers that always escalate to a human |
| `merge` | `method`: `merge` (default), `squash` or `rebase`, as the repo allows; `checks_timeout_min`: how long to wait for required status checks before asking you (default 30) |
| `loops` | Caps for build iterations, review rounds and spec critic rounds |
| `reviews` | Which review lenses run always and which only for UI changes |
| `models` | Model and effort per agent role and review lens, with overrides when triage rates the risk HIGH |
| `concurrency` | `max_runs`: how many runs `factory run` drives at once, and how many runs the worker (`factory work`, `factory serve`) keeps going per project (default 2) |
| `trust` | Whose issues and comments count as the spec |
| `github` | Optional status labels (`status_labels`, `label_prefix`); `max_starts_per_day`: how many new runs the worker may start per project in 24 hours, default 10 (see [Worker: Limits](docs/worker.md#limits)). `poll_interval_sec` is accepted but not used yet |

## Development

```sh
pnpm test        # vitest
pnpm typecheck   # tsc, including tests
pnpm lint        # eslint
pnpm build       # tsc -b, then the web app with Vite
pnpm factory status # run the CLI from source, on this repo
```

- To work on the web app with hot reload, run `factory serve --no-open` from the built CLI, then `pnpm -C apps/web dev`.
  - Vite proxies `/api` to the server (`FACTORY_SERVE_URL`, default `http://127.0.0.1:4180`).
  - Open the printed link with Vite's port instead of 4180.
  - The web tests run in jsdom with a fake server and event stream.
- The capture tests that drive a real browser run only where Playwright's Chromium is installed (`pnpm exec playwright install chromium`).
  - They are skipped otherwise.
  - Set `FACTORY_REQUIRE_BROWSER=1` (for example in CI) to make a missing browser fail the tests instead.
- The tests that render with the real narrate plugin are skipped unless you set `FACTORY_TEST_NARRATE=1`.
  - They test the narrate version installed on your machine, not this repo.
  - With the flag they need the plugin (in `~/.claude/plugins/cache`), ffmpeg on `PATH` and Playwright's Chromium, and fail if any of them is missing.
  - They use narrate's silent mock voice, so they cost nothing:

```sh
FACTORY_TEST_NARRATE=1 pnpm vitest run packages/core/src/capture/narrate.test.ts
```

- The quality gate runs `pnpm test` with your environment.
  So leave the flag unset in the shell that runs the factory, or an old narrate install can fail a run's `test` check.

Layout:

```
apps/cli          the `factory` command
apps/server       `factory serve`'s local HTTP server: API over the run actions, event stream, session token
apps/web          the web app (React, Vite, Tailwind), served by apps/server
packages/core     engine: config, SQLite store, state machine, gates, agent runner, prompts,
                  worktrees, quality gate, capture (app, browser), pipeline driver, init, GitHub issue sync, lessons PR,
                  and the run actions the CLI formats (run, approve, reject, resume, cancel, show, lessons, drafts)
  prompts/        shipped role prompts (override per repo in .factory/prompts/<role>.md)
  test/           fake `claude` binary and fixtures: tests never spend real usage
packages/shared   zod schemas shared by everything (config, run states, agent verdicts)
```

[CLAUDE.md](CLAUDE.md) has a file-by-file map, the invariants, checklists for adding a stage, an agent role, a migration or a GitHub call, and the security checklist.
Read it before changing the engine, whether you are a person or a Claude Code session.

### Dogfooding

The factory works on its own issues. It runs from a **pinned copy** of `main`, never from the code its runs change.

- **Why:** a merged PR, or an agent reaching outside its worktree, would otherwise change the code that is running.
  - `factory run`, `approve`, `resume` and `new "<idea>"` refuse to start agents with a copy that lives inside the repository they would change (its checkout or one of its `.worktrees/`).
  - Other commands, such as `pnpm factory status` or `approve --no-run`, still work from source.
- **Set up the pinned copy** once, outside every repository (PowerShell):

  ```powershell
  $pinned = "$env:LOCALAPPDATA\software-factory\pinned"
  git clone https://github.com/tomek-i/software-factory $pinned
  pnpm -C $pinned install --frozen-lockfile; pnpm -C $pinned build
  pnpm add -g "$pinned\apps\cli"   # the global `factory` now runs the pinned copy, replacing one linked from a dev checkout
  ```

- **Register this repo** with `factory init` in your checkout. The committed `.factory/config.yaml` is kept.
- **Run an issue** with `factory run <issue>` in your checkout.
  - In `.factory/config.yaml` every gate but `merge` is on `auto`: agents decide, and a run stops for you only on an escalation (a hard rule, an untrusted author, a loop cap) and at the merge gate.
  - The first run had every gate on `human`. Note that on `human` the spec critic runs no agent; the gate only asks you to accept the spec triage already showed you.
- **Update the pinned copy** only after a PR merged and no run is in progress:

  ```powershell
  $pinned = "$env:LOCALAPPDATA\software-factory\pinned"
  git -C $pinned pull --ff-only; pnpm -C $pinned install --frozen-lockfile; pnpm -C $pinned build
  ```

### Releases

- [release-please](https://github.com/googleapis/release-please) keeps a release PR open with the changelog built from the conventional commits on `main`.
- Merging that PR tags `v<version>`, publishes a GitHub release, and bumps the version in `package.json` and in `factory --version`.
- Only `feat`, `fix`, `perf`, `refactor`, `docs` and `revert` commits show in the changelog.
- CI does not run on the release PR: it is opened with the default `GITHUB_TOKEN`, and GitHub does not start workflows for that token's events.
- The PR only changes `CHANGELOG.md`, `.release-please-manifest.json` and version strings.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## License

Software Factory is **source-available** under the [PolyForm Noncommercial License 1.0.0](LICENSE). It is not open source in the OSI sense.

**Free to use for:**
- personal, hobby and private projects, as long as there is no anticipated commercial application;
- study, research and experiments, on the same condition;
- charities, schools, public research and government bodies.

**Needs a commercial license:**
- any use at or for a for-profit company, including internal tools;
- using it to build anything you plan to sell, such as an app or a SaaS;
- offering it, or a service built on it, to paying customers.

**Commercial license:** open an issue titled "Commercial license", or contact [tomek-i](https://github.com/tomek-i) through their GitHub profile.

**Contributing:** pull requests from others need a signed [Contributor License Agreement](CLA.md), so contributions can be included in commercially licensed versions. A bot asks for it on your first pull request.
