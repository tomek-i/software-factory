# Running an issue

Starting, steering and finishing runs.
The commands are in the [README](../README.md#running-an-issue), and what a run does is in [Pipeline](pipeline.md).

## Starting a run

- `factory run <n>` is enough for a brand-new issue.
- Running it is your decision to work on it.
  If the issue isn't queued yet, it is fetched fresh from GitHub and queued, the same as `factory queue <n>`.
- Closed issues are refused.
- An issue by an author outside `trust.authors` still waits for you at triage.

## Several runs at once

- Give several numbers to run them side by side in one terminal.
- At most `concurrency.max_runs` (default 2) run at once.
  The rest wait their turn.
- An issue that can't start (closed, not on GitHub) is skipped.
  The others still run, and the command exits non-zero.
- Once your usage limit is hit, issues not started yet are left for later.
- Ctrl+C stops all of them.

## Approve, resume and reject

- They apply the config on the default branch, like `factory run`, so a local edit cannot change where an approved run goes.
- `factory approve` and `factory resume` carry on driving the run in the same terminal, as `factory run` would.
- With `--no-run` they only record the decision.

## Naming a run

`<run>` is one of:

- a run id: the issue number, a slug of its title and a short random part, e.g. `49-shorter-builder-summaries-one-dfc238`.
  Runs created before this used `run-49-dfc23835`;
- a unique prefix of one;
- an issue number (`12`), for that issue's latest run.
  `#12` works too, but PowerShell reads `#` as the start of a comment, so quote it there (`'#12'`).

## Merging or closing on GitHub

- You can also merge or close the PR yourself on GitHub at any point.
- The next `factory status`, `factory run` or `factory sync` sees it.
- A merged PR marks the run `done`, with a `merge` decision holding the merge commit.
- A PR closed without merging marks it `cancelled`.
  You don't need `factory cancel`.
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
  - `factory status` and `factory run` also handle finished runs the cleanup has not handled yet, 2 minutes after they finished and only once no worker holds them, so a worker that is still stopping is never disturbed.
- **If cleanup fails** (for example, a file locked on Windows, or the remote out of reach), it's a warning in the output and the run's events, never a failure of the run.
  - A worktree that can't be removed is tried again a few times over a few seconds first.
  - The output lists only what was really removed.
  - The next `factory status` or `factory run` tries again, and finishes a removal that stopped half way.
- **`factory cleanup`** removes what older runs left behind; `factory cleanup --dry-run` lists it first.
  - Like the sweep, it waits 2 minutes after a run finished.
  - It also looks again at runs that were kept, so after you push their work, `factory cleanup` removes them.

## When a run escalates

- When a run escalates (agent failed, builder blocked, loop cap reached, loop stalled), `factory run` tells you why.
- A stall names both rounds, for example `stalled: quality gate failed the same way in rounds 2 and 3 (see round-2/checks.md and round-3/checks.md)`.
- A round is one pass through the quality gate (and the reviews after it).
- Round numbers keep counting after a resume, so earlier rounds' files are never overwritten.
- Send it on with `factory resume` or stop it with `factory cancel`.
- After a resume, stall detection starts afresh (with or without `--reset-loops`): only two more identical failures in a row stop the run again.
- If your Claude usage limit is hit, the run stops where it is.
  Run `factory run` again after the reset and it continues the same agent session.
- A malformed agent hand-over gets one retry with the problems listed, then the run waits for you.
