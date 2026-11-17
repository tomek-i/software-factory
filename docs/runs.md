# Runs

Starting, naming, continuing and cleaning up runs.
Back to the [README](../README.md#running-an-issue) for the commands; the stages are in [Pipeline](pipeline.md).

## Starting a run

- `factory run <n>` is enough for a brand-new issue.
- Running it is your decision to work on it.
- If the issue isn't queued yet, it is fetched fresh from GitHub and queued, the same as `factory queue <n>`.
- Closed issues are refused.
- An issue by an author outside `trust.authors` still waits for you at triage (see [Trusted authors](trust.md#trusted-authors)).

## Several runs at once

- Give several numbers to run them side by side in one terminal.
- Each output line is prefixed with its issue, e.g. `[#12]`, `[#15]`.
- At most `concurrency.max_runs` (default 2) run at once. The rest wait their turn.
- An issue that can't start (closed, not on GitHub) is skipped.
- The others still run, and the command exits non-zero.
- Once your usage limit is hit, issues not started yet are left for later.
- Ctrl+C stops all of them.

## Approve, resume and reject

- They apply the config on the default branch, like `factory run`.
- So a local edit cannot change where an approved run goes.
- `factory approve` and `factory resume` carry on driving the run in the same terminal, as `factory run` would.
- With `--no-run` they only record the decision.
- `factory resume` works on any run waiting for you, at a gate too.
  - It goes back to any stage up to where the run waits, or one step onward from there.
  - At a gate, sending it back to build with `-m "what to fix"` is the alternative to approving or rejecting it.
  - `--reset-loops` gives the build, review and spec loops a fresh budget.
  - Use it when a loop cap stopped the run: without it, the run stops again at once.

## Naming a run

`<run>` is one of:

- a run id: the issue number, a slug of its title and a short random part, e.g. `49-shorter-builder-summaries-one-dfc238`;
  - runs created before this used `run-49-dfc23835`;
- a unique prefix of one;
- an issue number (`12`), for that issue's latest run.
  - `#12` works too, but PowerShell reads `#` as the start of a comment, so quote it there (`'#12'`).

## Working through the queue

- `factory work` runs in the foreground and prints each run's progress prefixed with `[project#issue]`.
- Every few seconds it picks work from every project in the project list (see `factory projects`).
- It picks in this order:
  1. **Stopped runs first.** A run in a working stage whose issue is still queued and that nobody is working on is continued where it stopped.
  2. **Then queued issues**, in queue order.
- Stopped runs cover:
  - a worker that was killed, once its 15-minute lease expires;
  - a run interrupted with Ctrl+C or `factory stop --now`;
  - a run stopped by the usage limit.
- A run started with `--unsafe` is left for you to continue with `factory run`.
- Runs waiting for you (`needs_human`) or for the issue's author (`needs_info`) are never picked up.
- The worker never sends a `needs_info` run back to triage.
- To keep the worker off a run, unqueue its issue or cancel the run.
- Each issue is fetched from GitHub just before its run starts or continues, and work on one closed there stops.
- An issue starts once per time it is queued.
- After its run failed, was rejected or cancelled, the worker leaves it alone.
- To try it again, `factory unqueue` and `factory queue` it, or `factory run` it.
- Runs are driven exactly as with `factory run`: the same gates, hard rules and trusted authors.
- The worker never lifts hard rules (no `--unsafe`).

Its limits:

- `concurrency.max_runs` per project. This counts runs other processes are driving too, such as a `factory run` in another terminal.
- `--max-runs` for the worker, across projects (default 3).
- `github.max_starts_per_day` per project (default 10): new runs in the last 24 hours, by anyone.
  - Continuing a run doesn't count.
  - 0 means the worker starts nothing new in that project.

The usage limit:

- When an agent hits the subscription's usage limit, the worker starts and continues nothing more.
- Runs already going carry on, and stop when they hit it too.
- The pause lasts until the reset time the agent reported, or for 30 minutes when it didn't say.
- Then it continues the stopped runs before anything new.

Stopping:

- `factory stop` works through a `stop.json` in the factory's data folder, so it reaches workers in other terminals.
- A worker obeys only a request made after it started.
- Ctrl+C in the worker's terminal interrupts its runs like `factory stop --now` and exits.

## Merging or closing on GitHub

- You can also merge or close the PR yourself on GitHub at any point.
- The next `factory status`, `factory run` or `factory sync` sees it.
- A merged PR marks the run `done`, with a `merge` decision holding the merge commit.
- A PR closed without merging marks it `cancelled`. You don't need `factory cancel`.
- Runs without a PR, or with an open one, are left alone.
- If GitHub can't be reached, the command prints a warning and carries on.

## Cleaning up finished runs

- When a run ends, its worktree (`.worktrees/<run>`, a full checkout with `node_modules`) and its branches are removed.
- Its run folder, `.factory/runs/<run>/`, is never touched.
- **Merged** (`done`):
  - The worktree and the local branch go when everything in them was part of the merged PR.
  - The remote branch goes too, unless GitHub already deleted it, or someone pushed to it after the merge.
- **Rejected, cancelled or failed**:
  - The worktree and the local branch go only when everything in them is on the remote.
  - The remote branch stays, so a closed PR can be reopened from it.
- **Work that would be lost is kept.**
  - Uncommitted changes keep both the worktree and the branch.
  - So do commits on the branch or the worktree's HEAD that are not on the remote (or, for a merged run, not in what was merged).
  - The reason is noted in the run's events.
- **Who does it:**
  - the worker that finished the run, once it has stopped;
  - `factory reject`, and `factory cancel` of a run no worker is driving, right away;
  - `factory status` and `factory run`, right away, for runs they themselves finish because their PR was merged or closed on GitHub;
  - `factory status` and `factory run`, for finished runs the cleanup has not handled yet, 2 minutes after they finished and only once no worker holds them.
    - So a worker that is still stopping is never disturbed.
- **If cleanup fails** (for example, a file locked on Windows, or the remote out of reach):
  - it's a warning in the output and the run's events, never a failure of the run;
  - a worktree that can't be removed is tried again a few times over a few seconds first;
  - the output lists only what was really removed;
  - the next `factory status` or `factory run` tries again, and finishes a removal that stopped half way.
- **`factory cleanup`** removes what older runs left behind.
  - `factory cleanup --dry-run` lists it first.
  - Like the sweep, it waits 2 minutes after a run finished.
  - It also looks again at runs that were kept, so after you push their work, `factory cleanup` removes them.

## When a run escalates

- A run escalates when an agent failed, the builder was blocked, a loop cap was reached or a loop stalled.
- `factory run` tells you why.
- A stall names both rounds.
  - For example `stalled: quality gate failed the same way in rounds 2 and 3 (see round-2/checks.md and round-3/checks.md)`.
- A round is one pass through the quality gate (and the reviews after it).
- Round numbers keep counting after a resume, so earlier rounds' files are never overwritten.
- Send it on with `factory resume` or stop it with `factory cancel`.
- After a resume, stall detection starts afresh (with or without `--reset-loops`).
- Only two more identical failures in a row stop the run again.
- If your Claude usage limit is hit, the run stops where it is.
- Run `factory run` again after the reset and it continues the same agent session.
- A malformed agent hand-over gets one retry with the problems listed, then the run waits for you.
- What the run left behind is described in [Run artifacts](run-artifacts.md).

## When a required check fails

- The merge stage stops for you when a check branch protection requires fails on the PR.
- `factory checks <run>` lists the failed checks, and for code scanning checks (CodeQL or another SARIF tool) their open alerts on the PR's head: rule, severity, file and line, link.
- A check counts as code scanning when the PR has open alerts from a tool of the check's name.
- **A real problem**: send the run to the builder, e.g. `factory resume <run> --to build --reset-loops -m "CodeQL: Missing rate limiting at src/drafts.ts:296"`.
- **A false positive**: `factory dismiss <run> <alert> --reason false-positive -m "why"`.
  - The reasons are GitHub's: `false-positive`, `wont-fix` or `used-in-tests`.
  - The message is required; GitHub takes at most 280 characters.
  - Only an open alert of a failed required check on the run's own PR can be dismissed.
  - It is your decision, recorded on the run; agents never dismiss alerts.
  - GitHub then updates the check in place, without a new CI run.
  - When no required check fails any more, the run goes back to merge, which checks everything again on the same commit.
  - A merge approval you already gave still holds, since the commit did not change; without one, the merge gate decides as usual.
  - While a check still fails (other alerts are open, or GitHub has not updated it yet), the run keeps waiting.
  - Dismissing needs a `gh` login whose token may write code scanning alerts (the `security_events` scope, or Code scanning alerts: write).
- **Any other failed required check** can't be accepted from the factory: branch protection would refuse the merge anyway.
  - Only the builder path is offered for it.

## What steers the agents

- `factory run` reads `.factory/config.yaml`, `.factory/prompts/<role>.md`, `.factory/lessons.md` and the repo's root `CLAUDE.md` from `origin/<default branch>`.
- It never reads them from your working copy.
- So a checked-out branch cannot change its own checks, trust list, gates or prompts.
- A `CLAUDE.md` changed on a run's branch has no effect on that run's agents (see [Project notes](agent-permissions.md#project-notes-claudemd)).
- Commit and push config changes before they take effect.
