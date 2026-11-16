# Worker

The project list, choosing what the factory works on, and `factory work`.
The commands are in the [README](../README.md#working-through-the-queue).

## The project list

- The project list holds every repo you ran `factory init` in, so `factory work` and `factory serve` can find them.
- It is one file per user: `%LOCALAPPDATA%\software-factory\projects.json` on Windows.
  Elsewhere it is `~/.config/software-factory/projects.json` (`$XDG_CONFIG_HOME`).
- `FACTORY_DATA_DIR` moves that folder, together with the GitHub browser profile.
- The list only holds paths and names; each repo keeps its own state.
- `factory projects` lists the repos and flags one whose folder has gone, or that has no `.factory/factory.db`.
- `factory projects remove <path>` drops a repo from the list.
  The repo and its database are not touched.
- A repo set up before the list existed joins it when you run `factory init` there again.

## Choosing what the factory works on

- Work is picked **locally**, never from GitHub labels, so nobody on GitHub can feed issues into your factory.
- Issues closed on GitHub drop out of the queue on the next sync.

## Working through the queue

- `factory work` runs in the foreground and prints each run's progress prefixed with `[project#issue]`.
- Every few seconds it picks work from every project in the project list (see `factory projects`).
- **Stopped runs first.** A run in a working stage whose issue is still queued and that nobody is working on is continued where it stopped.
  - That covers a worker that was killed (once its 15-minute lease expires).
  - It also covers a run interrupted with Ctrl+C or `factory stop --now`, and a run stopped by the usage limit.
  - A run started with `--unsafe` is left for you to continue with `factory run`.
  - Runs waiting for you (`needs_human`) or for the issue's author (`needs_info`) are never picked up.
  - The worker never sends a `needs_info` run back to triage.
  - To keep the worker off a run, unqueue its issue or cancel the run.
- **Then queued issues**, in queue order.
  - Each issue is fetched from GitHub just before its run starts or continues, and work on one closed there stops.
  - An issue starts once per time it is queued: after its run failed, was rejected or cancelled, the worker leaves it alone.
  - To try it again, `factory unqueue` and `factory queue` it, or `factory run` it.
- Runs are driven exactly as with `factory run`: the same gates, hard rules and trusted authors.
- The worker never lifts hard rules (no `--unsafe`).

## Limits

- `concurrency.max_runs` per project.
  This counts runs other processes are driving too, such as a `factory run` in another terminal.
- `--max-runs` for the worker, across projects.
- `github.max_starts_per_day` per project: new runs in the last 24 hours, by anyone.
  - Continuing a run doesn't count.
  - 0 means the worker starts nothing new in that project.

## Usage limit

- When an agent hits the subscription's usage limit, the worker starts and continues nothing more.
  - Runs already going carry on, and stop when they hit it too.
  - It waits until the reset time the agent reported, or for 30 minutes when it didn't say.
- Then it continues the stopped runs before anything new.

## Stopping

- `factory stop` works through a `stop.json` in the factory's data folder, so it reaches workers in other terminals.
- A worker obeys only a request made after it started.
- Ctrl+C in the worker's terminal interrupts its runs like `factory stop --now` and exits.
