# Configuration

What you can set in `.factory/config.yaml`, and how to go back to the defaults.
`factory init` writes the file with comments; this page is the overview.
The web app's [Settings screen](web-mode.md#settings) shows every setting and saves a change to the default branch for you.

- Runs read the config from your **default branch on GitHub**, not from your working copy.
  Commit and merge a change before it takes effect, so a branch can never change the rules it is judged by.
- Anything the file leaves out uses the factory's default.
  New settings and changed defaults reach your project with the next factory update.
- A value written in the file stays as it is.

## The sections

| Section | What it sets |
|---|---|
| [`project`](#project) | The project's name and the branch the factory builds from |
| [`checks`](#checks) | The commands that must pass before reviews start |
| [`app`](#app) | How to start your app for screenshots and videos of UI changes |
| [`gates`](#gates) | Where a run stops for you |
| [`hard_rules`](#hard_rules) | Changes that always stop for you |
| [`merge`](#merge) | How and when the PR is merged |
| [`loops`](#loops) | How often a run may go back to an earlier stage |
| [`reviews`](#reviews) | Which review lenses run |
| [`security`](#security) | The deep security scan of each change |
| [`models`](#models) | Which model and effort each agent uses |
| [`concurrency`](#concurrency) | How many runs go on at once |
| [`trust`](#trust) | Whose issues and comments count as the spec |
| [`github`](#github) | Status labels and the daily start limit |

## project

- `name`: the project's name, as the factory shows it.
- `default_branch` (default `main`): the branch the factory builds from and reads this file from.

## checks

The commands that must all pass before reviews start (the [quality gate](pipeline.md#quality-gate)).
Each check has:

- `name`;
- `run`: a shell command, run in the run's worktree;
- `timeout_sec` (default 900);
- `retries`: how often a failed check runs again before the gate fails (default 1).

## app

How to start your app, so the factory can show a UI change in the PR with screenshots and a video.
Leave `start` unset and nothing is captured.

- `start`: a shell command, run in the worktree.
- `url` (default `http://localhost:{port}`): must contain `{port}`, which the factory fills in.
- `port_env` (default `PORT`): the environment variable that carries the port.
- `ready_timeout_sec` (default 180): how long `url` may take to answer.
- `narrate` (default `auto`): `auto`, `off` or a path to `narrate.mjs` (see [Narrated walkthrough](capture.md#narrated-walkthrough)).
- `env`: names of variables to pass from your environment to the app.
  The app otherwise gets only a minimal environment, and tokens are never passed.

## gates

A gate is a point where a run can stop for you.
Each gate has a mode:

- `always`: pass through.
- `auto`: the agent decides, or stops for you with its reasons.
- `human`: always stop for you.

| Gate | Default | Where |
|---|---|---|
| `issue_writer` | `human` | before `factory new` creates its issues |
| `triage` | `auto` | after triage reads the issue |
| `critic` | `auto` | after the spec critic checks the spec |
| `review` | `auto` | after the reviews |
| `pr` | `always` | before the PR is opened |
| `merge` | `human` | before the PR is merged |

- The config also accepts a `plan` gate (default `always`), but no stage uses it yet.
- Whatever the mode, [hard rules](pipeline.md#hard-rules) and untrusted authors always stop for you.

## hard_rules

Changes that always stop for you, whatever the gate mode.
Among them: protected paths, new dependencies, lockfile changes, secret and environment files, and deleted files the issue doesn't name.

- `paths`: protected paths to add, as repo-relative globs using only `*`, `**` and `?`.
  They add to the factory's own protected paths; they can never remove one.
- `triggers` can't switch a rule off either: every trigger always applies.
- The full list of rules: [Hard rules](pipeline.md#hard-rules).

Only a per-run `factory run --unsafe` lifts them; it can never be set in this file.

## merge

- `method` (default `merge`): `merge`, `squash` or `rebase`, as the repo allows.
- `checks_timeout_min` (default 30): how long to wait for the PR's required checks before asking you.
- `open_feedback` (default `ask`): what to do about unresolved review threads, and failed checks branch protection doesn't require:
  - `ask`: wait for you;
  - `fix`: send them to the builder;
  - `ignore`: don't look at them.
- `comment_bots` (default `["github-advanced-security[bot]"]`): apps whose threads `fix` may act on without you.
- `followup_issues` (default `true`): open an issue for each review note the builder defers before the merge; off, its thread only says it was deferred.
- `queue_followups` (default `false`): queue those follow-up issues for the factory, rather than leave them for you to pick.
  They are opened by your account, so they run trusted if that account is in `trust.authors`.

More: [The factory's own review notes](pipeline.md#the-factorys-own-review-notes) and [Open review threads and failed checks](pipeline.md#open-review-threads-and-failed-checks).

## loops

A loop sends a run back to an earlier stage. Each has a cap; at the cap the run stops for you.

| Setting | Default | Counts |
|---|---|---|
| `max_critic_rounds` | 2 | the spec critic sending the spec back to refine |
| `max_build_iterations` | 5 | failed checks sending the build back |
| `max_review_rounds` | 3 | confirmed review findings sending the build back |
| `max_resyncs` | 3 | the merge stage sending the build back: conflicts, failed re-checks, open feedback with `fix` |

## reviews

- `always` (default `code`, `security`, `docs`): the review lenses that look at every change.
- `ui` (default `ux`, `ui`): the lenses that only look at UI changes.
- The `acceptance` lens, which checks the issue's acceptance criteria, always runs.

## security

A deep scan of each change with Anthropic's [claude-security](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/claude-security) Claude Code plugin, as one more review lens, `security-scan`.
Install it first: `/plugin install claude-security@claude-plugins-official`.
See [Pipeline: Deep security scan](pipeline.md#deep-security-scan) for what it does with the findings.

| Setting | Default | What it does |
|---|---|---|
| `scan_when` | `off` | `off`, `high_risk` (only when triage rated the risk HIGH) or `always` |
| `scan_tool` | `auto` | `auto` finds the plugin in Claude Code's plugin cache; `off`; or a path to its `scripts/cli.py` |
| `scan_effort` | `low` | `low`, `medium` or `high`, passed to the scan; higher costs more |
| `scan_timeout_min` | 60 | a longer scan is stopped and the review goes on without it |

- The scan runs many agents on your Claude Code login, so it costs several times a review lens.
- Its model comes from [`models`](#models) like any lens's: `models.reviews.security-scan`, else the reviewer's.

## models

The model and effort for each agent role and review lens, with stronger overrides when triage rates the risk HIGH.

- Left out, every agent uses the recommended model.
  The recommendations are `DEFAULT_MODELS` in `packages/shared/src/config.ts`, shown commented out in a new config.
- Whatever the file sets wins over every recommendation.
  `default` and `effort` reach every agent the file doesn't name; the recommendations only fill in the rest.
- A config written by an older `factory init` spells out the models of that time.
  `factory config reset models` gives it the current recommendations.

## concurrency

- `max_runs` (default 2): how many runs `factory run` drives at once, and how many the worker drives per project.

## trust

Whose issues and comments count as the spec. See [Trust](trust.md).

## github

- `status_labels` (default off) and `label_prefix` (default `factory`): see [Status labels](#status-labels).
- `max_starts_per_day` (default 10): how many new runs the worker starts per project in a rolling 24 hours.
  Every started run counts, cancelled and rejected ones included.
  When it holds queued issues back, `factory status`, `factory issues`, `factory work` and the web app (header, Inbox and Backlog) say so, and when the next one can start.
  See [Its limits](runs.md#its-limits).
- `poll_interval_sec` is accepted but not used yet.

### Status labels

- With `github.status_labels: true`, the factory mirrors a run's status onto its issue as labels.
- The labels are `factory`, `factory:in-progress`, `factory:needs-info`, `factory:needs-human` and `factory:unsafe`.
- `github.label_prefix` sets the prefix (default `factory`).
- They are display-only and never read as input.
  Work is picked locally, never from GitHub labels, so nobody on GitHub can feed issues into your factory.
- `factory init --labels` turns them on and creates the labels.
  If you turn them on by hand instead, run `factory init` again to create the labels.

## What steers the agents

Besides this file, the agents are steered by:

- `.factory/prompts/<role>.md`: your own prompt for an agent role, replacing the shipped one;
- `.factory/lessons.md`: the [lessons](lessons.md) you approved;
- the repo's root `CLAUDE.md` (see [Project notes](agent-permissions.md#project-notes-claudemd)).

All of them, like this file, are read from `origin/<default branch>`, never from your working copy.
So a checked-out branch can't change its own checks, trust list, gates or prompts, and a `CLAUDE.md` changed on a run's branch has no effect on that run's agents.
Commit and push changes before they take effect.

## Going back to the defaults

```sh
factory config reset models                 # a whole section
factory config reset models.roles.builder   # one entry
factory config reset --all                  # everything except project, checks, app and trust
```

- It removes those lines, and the comments right above them, from the working copy's `.factory/config.yaml`.
- It leaves the rest of the file as it was.
- Commit the change and merge it: runs read the config from the default branch on GitHub.

[All docs](README.md)
