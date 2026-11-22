# Runs

A run is one issue's trip through the [pipeline](pipeline.md).
This page covers how runs start, how the worker picks them, what to do when one stops for you, and how they are cleaned up.
The commands are in [Using the factory](usage.md#run-an-issue).

## Naming a run

Commands such as `factory approve <run>` and `factory show <run>` take `<run>` as one of:

- a run id: the issue number, a slug of its title and a short random part, e.g. `49-shorter-builder-summaries-one-dfc238`;
  - runs created before this used `run-49-dfc23835`;
- a unique prefix of one;
- an issue number (`12`), for that issue's latest run.
  - `#12` works too, but PowerShell reads `#` as the start of a comment, so quote it there (`'#12'`).

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
  The others still run, and the command exits non-zero.
- Once your usage limit is hit, issues not started yet are left for later (see [The usage limit](#the-usage-limit)).
- Ctrl+C stops all of them.

## Working through the queue

`factory work` (and `factory serve`, which runs the same worker) keeps going until you stop it.

- `factory work` works on the project of the folder it is started in, a run's worktree included.
  `factory work --all` and `factory serve` work on every project in the project list.
- It runs in the foreground and prints each run's progress prefixed with `[project#issue]`.
- Every few seconds it picks work from those projects (see `factory projects` for the list).
- It picks in this order:
  1. **Stopped runs first.** A run in a working stage whose issue is still queued, and that nobody is working on, is continued where it stopped.
  2. **Then queued issues**, in queue order.
- Stopped runs are:
  - a run whose worker was killed: another worker picks it up 15 minutes later, once the old one's claim on it (its lease) expires;
  - a run interrupted with Ctrl+C or `factory stop --now`;
  - a run stopped by the usage limit.
- A run started with `--unsafe` is left for you to continue with `factory run`.
- Runs waiting for you (`needs_human`) or for the issue's author (`needs_info`) are never picked up.
- The worker never sends a `needs_info` run back to triage.
- To keep the worker off a run, unqueue its issue or cancel the run.
- Each issue is fetched from GitHub just before its run starts or continues, and work on one closed there stops.
- An issue starts once per time it is queued.
  After its run failed, was rejected or cancelled, the worker leaves it alone.
  To try it again, `factory unqueue` and `factory queue` it, or `factory run` it.
- Runs are driven exactly as with `factory run`: the same gates, [hard rules](pipeline.md#hard-rules) and trusted authors.
- The worker never lifts hard rules (no `--unsafe`).

### Its limits

- `concurrency.max_runs` per project. This counts runs other processes are driving too, such as a `factory run` in another terminal.
- `--max-runs` for the worker, across its projects (default 3).
  Each worker keeps to its own, so two `factory work` in different projects can drive twice as many runs.
- `github.max_starts_per_day` per project (default 10): new runs in the last 24 hours, by anyone.
  - It is a rolling 24 hours, not a calendar day: a run counts for exactly 24 hours after it started.
  - Every started run counts, cancelled and rejected ones included.
  - Continuing a run doesn't count.
  - 0 means the worker starts nothing new in that project.
  - When it holds queued issues back, the worker says so once per project, with the time the next one can start, and again when it lifts.
    `factory status`, `factory issues` and the web Backlog and Inbox show the same line while it holds.
    The web app's header shows it too, as "start limit until" the time the first held project can start again.

### The usage limit

- When an agent hits your Claude subscription's usage limit, the run stops where it is.
- The worker then starts and continues nothing more; runs already going carry on, and stop when they hit it too.
- The pause lasts until the reset time the agent reported, or 30 minutes when it didn't say.
- Then the worker continues the stopped runs before anything new.
- Without a worker, run `factory run` again after the reset: it continues the same agent session.

### Stopping

- `factory stop` works through a `stop.json` in the factory's data folder, so it reaches workers in other terminals.
  The data folder is `%LOCALAPPDATA%\software-factory` on Windows, `~/.config/software-factory` elsewhere, or `FACTORY_DATA_DIR`.
- A worker obeys only a request made after it started.
- Ctrl+C in the worker's terminal interrupts its runs like `factory stop --now` and exits.
- A running worker keeps a file in `workers/` in the same folder, so `factory upgrade` knows not to replace the factory under it.
- While `factory upgrade` checks and installs, it holds an `upgrading.json` there, and a worker refuses to start.

## When a run stops for you

A run stops for you (escalates) when:

- a gate is set to `human`, or a [hard rule](pipeline.md#hard-rules) was hit;
- an agent failed, or the builder said it was blocked;
- a loop reached its cap, or stalled;
- a required check failed, or review threads are open on the PR.

`factory run` tells you why, and so do `factory status`, `factory show` and the web Inbox.

### Stalls and rounds

- A round is one pass through the build, the quality gate and the reviews.
- Round numbers keep counting after a resume, so earlier rounds' files are never overwritten.
- A stall names both rounds.
  For example `stalled: quality gate failed the same way in rounds 2 and 3 (see round-2/checks.md and round-3/checks.md)`.
- After a resume, stall detection starts afresh (with or without `--reset-loops`).
  Only two more identical failures in a row stop the run again.
- If an agent's output file is missing or malformed, the agent gets one retry with the problems listed; then the run stops for you.
- What the run left behind is described in [Run artifacts](run-artifacts.md).

### Approve, resume, reject or cancel

- `factory approve` lets a run waiting at a gate continue; `factory reject` ends it.
- `factory resume` sends any run waiting for you, at a gate too, back to a stage.
  - It goes back to any stage up to where the run waits, or one step onward from there.
  - At a gate, sending it back to build with `-m "what to fix"` is the alternative to approving or rejecting it.
  - `--reset-loops` gives the build, review, spec and re-sync loops a fresh budget.
    Use it when a loop cap stopped the run: without it, the run stops again at once.
- `factory cancel` stops the run, its agent and its checks.
- `factory approve` and `factory resume` carry on driving the run in the same terminal, as `factory run` would.
  With `--no-run` they only record the decision.
- They apply the config on the default branch, like `factory run`, so a local edit can't change where an approved run goes.

### When a required check fails

- The merge stage stops for you when a check branch protection requires fails on the PR.
- `factory checks <run>` lists the failed checks.
  For code scanning checks (CodeQL or another SARIF tool) it adds their open alerts on the PR's head: rule, severity, file and line, link.
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
  Only the builder path is offered for it.

### When review threads or checks are open on the PR

By default the merge gate waits for you while the PR has unresolved review threads, or failed checks branch protection doesn't require.
What you can do about them: [Open review threads and failed checks](pipeline.md#open-review-threads-and-failed-checks).

## Merging or closing on GitHub

- You can also merge or close the PR, or close the issue, yourself on GitHub at any point.
- The next `factory status`, `factory run` or `factory sync` sees it.
- A merged PR marks the run `done`, with a `merge` decision holding the merge commit.
- A PR closed without merging marks it `cancelled`. You don't need `factory cancel`.
- An issue closed on GitHub (done in another PR, a duplicate, not planned) marks a run without an open PR `cancelled`.
  - The decision says how and by which PRs it was closed, e.g. `issue #173 was closed on GitHub (completed, by #221)`.
- A run whose issue was closed while its PR is still open is left for you, since closing a PR is your call.
  - `factory status` shows `issue closed` in its WAITING column; `factory show` and the web app say what cancelling does.
  - `factory cancel` (or Cancel run in the web app) then also closes the PR, with a comment, and deletes its branch.
  - It asks GitHub first: an issue reopened since is recorded open again, and the PR stays.
  - If GitHub refuses to close the PR, the run is not cancelled and the output says why; close the PR on GitHub and the next sync cancels the run.
- An issue reopened on GitHub is recorded open again; it is not queued again until you queue it.
- Runs whose PR and issue are both open are left alone.
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
    Once a later cleanup removes them, that is noted too, so the run no longer says it was kept.
- **Who does it:**
  - the worker that finished the run, once it has stopped;
  - `factory reject`, and `factory cancel` of a run no worker is driving, right away;
  - `factory status`, `factory sync` and `factory run`, right away, for runs they finish themselves because their PR or issue was closed or merged on GitHub;
  - `factory status`, `factory sync` and `factory run`, for finished runs not cleaned up yet, 2 minutes after they finished and only once no worker holds them.
    So a worker that is still stopping is never disturbed.
    A worker that died holds its run until its lease runs out.
- **If cleanup fails** (for example, a file locked on Windows, or the remote out of reach):
  - it's a warning in the output and the run's events, never a failure of the run;
  - a worktree that can't be removed is tried again a few times over a few seconds first;
  - the output lists only what was really removed;
  - the next `factory status` or `factory run` tries again, and finishes a removal that stopped half way.
- **`factory cleanup`** removes what older runs left behind.
  - `factory cleanup --dry-run` lists it first.
  - Like the automatic cleanup, it waits 2 minutes after a run finished, and leaves a run a worker still holds to that worker.
    It lists the runs it left alone, with why.
  - `factory cleanup --now` skips the 2 minutes; a run a worker still holds is still left to it.
  - It also looks again at runs that were kept, so after you push their work, `factory cleanup` removes them.
  - A merged run whose remote branch was kept (someone pushed to it after the merge) has nothing left on your machine: its worktree and local branch are removed.
  - The web app does the same: "Clean up finished runs" on the Runs screen, and "Clean up" on a finished run's details ([Web mode](web-mode.md)).

[All docs](README.md)
