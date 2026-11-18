# Using the factory

Every command, in the order you meet them: install, set up a repo, pick work, run it and look after it.
New here? The [README](../README.md#quick-start) has a five-command quick start.

- [Install, update, remove](#install-update-remove)
- [Set up a repo](#set-up-a-repo)
- [Write issues from an idea](#write-issues-from-an-idea)
- [Choose what the factory works on](#choose-what-the-factory-works-on)
- [Run an issue](#run-an-issue)
- [Work through the queue](#work-through-the-queue)
- [Web mode](#web-mode)
- [Move to another machine](#move-to-another-machine)

## Install, update, remove

```sh
npm i -g @tomek-i/software-factory   # puts `factory` on your PATH
factory upgrade                      # update to the latest release
factory upgrade --check              # only say whether a newer version is out
npm rm -g @tomek-i/software-factory  # remove it
```

What you need first is in the [README](../README.md#requirements).

With pnpm:

- Install with `pnpm add -g @tomek-i/software-factory`.
- pnpm's global bin folder must be on your `PATH`; run `pnpm setup` once if it complains.
- If pnpm says it skipped `better-sqlite3`'s build script, run `pnpm approve-builds -g` and approve it.

How `factory upgrade` behaves:

- It installs with the package manager that installed the factory (npm, pnpm or yarn).
  When it can't tell which one did, it prints the commands to run by hand.
- It refuses while `factory work` or `factory serve` runs, or while any run is being driven.
  Windows can't replace files a running factory has open, and the engine must not change under a run.
- Close other factory commands, such as `factory logs -f` or `factory new`, before upgrading: it doesn't look for them.
- While it installs, `factory work` and `factory serve` refuse to start.
- It refuses a copy built from a checkout: update that with `git pull` and `pnpm build`.
- On Windows the running `factory.cmd` is replaced: if the shell prints an error afterwards, open a new terminal.
- Each project's database is migrated when the new version first opens it, so an older factory can't read it afterwards.
- By hand: `npm i -g @tomek-i/software-factory@latest`.

To work on the factory itself from a checkout, see [Contributing](../CONTRIBUTING.md#run-from-source).

## Set up a repo

```sh
cd path/to/your/repo
factory init --sync    # set the repo up and pull its open issues
```

`factory init`:

- detects your stack (Node, .NET, Python, Go) and writes `.factory/config.yaml` with your check commands.
  Review it, especially the checks, then commit it.
- writes `.factory/lessons.md`, which agents read before every run.
- adds the factory's runtime state (`.factory/runs/`, `.factory/factory.db*`, `.worktrees/`, `.factory/drafts/`) to `.gitignore`.
- registers the project in `.factory/factory.db` and adds the repo to your [project list](#the-project-list).
- creates GitHub status labels only if they are on (off by default; see [Status labels](configuration.md#status-labels)).

Options:

- `--sync` pulls issues from GitHub afterwards, as `factory sync` does.
  A failed sync is a warning: the repo is still set up, and `factory sync` tries again.
  Without a GitHub `origin` remote it is skipped with a warning.
- `--name <name>` sets `project.name` instead of the detected name, in a new config or the existing one.
  It is trimmed; a blank one is refused.
- `--labels` turns `github.status_labels` on and creates the labels.
- `--dry-run` lists what would be written or created and changes nothing.
  It still reads your GitHub login, as a real run does, to fill in the trusted authors of a new config.

It is safe to run again:

- An existing config is never replaced: only `--name` and `--labels` change it, one value each.
  Comments and formatting stay.
- If that setting isn't in the file, init stops before writing anything and asks you to add it by hand.
- `factory config reset` brings settings back to the defaults (see [Configuration](configuration.md#going-back-to-the-defaults)).

### The project list

The project list holds every repo you ran `factory init` in, so `factory work` and `factory serve` can find them.

- It is one file per user:
  - on Windows, `%LOCALAPPDATA%\software-factory\projects.json`;
  - elsewhere, `~/.config/software-factory/projects.json` (`$XDG_CONFIG_HOME`).
- `FACTORY_DATA_DIR` moves that folder, together with the GitHub browser profile.
- The list only holds paths and names; each repo keeps its own state.
- `factory projects` lists the repos and flags one whose folder has gone, or that has no `.factory/factory.db`.
- `factory projects remove <path>` drops a repo from the list. The repo and its database are not touched.
- A repo set up before the list existed joins it when you run `factory init` there again.

### Screenshots and videos on PRs

`factory login github` opens a browser and waits for you to sign in to GitHub there.
The factory then attaches screenshots and videos to its PRs.
Run it again to check who is signed in.
See [Capture](capture.md#where-the-media-goes).

## Write issues from an idea

```sh
factory new "export orders as CSV"           # draft an issue from an idea
factory new "export orders as CSV" --queue   # the same, and queue the issues once created
factory new --list                           # drafts waiting for you
factory new --approve <draft>                # create a draft on GitHub and sync it
factory new --approve <draft> --queue        # the same, and queue the issues
factory new --discard <draft>                # drop a draft
```

- An issue writer agent drafts the issue; by default you approve the draft before it goes to GitHub.
- It labels each issue with labels the repo already has, never the factory's status labels.
- Without `--queue`, the new issues wait until you queue them.
- How drafts, the gate and sub-issues work: [Writing issues from an idea](factory-new.md).
- The web app's New issue screen does the same: [Web mode](web-mode.md#screens).

## Choose what the factory works on

Work is picked **locally**, never from GitHub labels, so nobody on GitHub can feed issues into your factory.

```sh
factory sync               # pull open issues from GitHub; also finishes and cleans up runs whose PR or issue was closed there
factory issues             # list them (Q marks queued ones); -q/--queued, -a/--all
factory queue 12 15 18     # queue issues for the factory (fetches ones not synced yet)
factory unqueue 15         # take one back out
```

Issues closed on GitHub drop out of the queue on the next sync.
Whose issues the factory treats as the spec: [Trust](trust.md).

## Run an issue

```sh
factory run 12             # run issue #12 until it needs you (syncs and queues it first if needed)
factory run 12 15          # run several at once, up to concurrency.max_runs; lines are prefixed [#12], [#15]
factory status             # active runs: state, round, cost, waiting gate; -a/--all includes finished ones
factory logs 12            # events and agent log excerpts; -f/--follow follows a running run
factory show 12            # overview: state, gate, branch, PR, verdicts, files in the run folder
factory show 12 triage     # one file in full, e.g. triage, build, checks, approval, learn or round-2/checks.md
```

When a run waits for you:

```sh
factory approve <run>                      # let it continue past the gate; -m "why", --no-run to only record it
factory reject <run> -m "why"              # end a run waiting at a gate
factory resume <run> --to build -m "why"   # send it back to a stage and keep going; --reset-loops, --no-run
factory checks <run>                       # the required checks that failed on its PR, with code scanning alerts
factory dismiss <run> <alert> --reason false-positive -m "why"   # dismiss a code scanning alert
factory cancel <run>                       # stop the run, its agent and its checks; -m "why" is optional
```

Afterwards:

```sh
factory cleanup                     # remove worktrees and branches finished runs left behind; --dry-run first, --now for runs that just finished
factory lessons                     # lessons the learner proposed; -a/--all includes decided ones
factory lessons approve 3 4         # open one PR that adds these lessons to .factory/lessons.md
factory lessons reject 5 -m "why"   # never apply this lesson; -m is optional
```

- `<run>` is a run id, a unique prefix of one, or an issue number for that issue's latest run (see [Naming a run](runs.md#naming-a-run)).
- `--unsafe` on `factory run` lifts the [hard rules](pipeline.md#hard-rules) for that run only.
- `factory status --all` finishes runs merged on GitHub first, and notes lessons waiting for you.
- `factory show <run> <file>` takes triage, refine and critic (latest spec round), build, checks or capture (latest round), approval, learn, or a path in the run folder.
- After `factory dismiss`, the run goes back to the merge stage once the check passes.
- What `factory cancel` leaves behind and how to remove it: [Cleaning up finished runs](runs.md#cleaning-up-finished-runs).
- Starting, merging on GitHub, cleanup and escalations: [Runs](runs.md).
- What each stage does: [Pipeline](pipeline.md).
- The files a run leaves in `.factory/runs/<run>/`: [Run artifacts](run-artifacts.md).
- Approving and rejecting lessons: [Lessons](lessons.md).

## Work through the queue

```sh
factory work               # work through every registered project's queue until stopped; --max-runs <n> (default 3)
factory stop               # tell running workers to start nothing new, finish their runs and exit
factory stop --now         # tell them to interrupt their runs and exit; the runs can be continued later
```

- The worker continues stopped runs first, then starts queued issues in queue order.
- It keeps to `concurrency.max_runs`, `--max-runs` and `github.max_starts_per_day`, and pauses on the usage limit.
- How it picks, its limits and stopping: [Working through the queue](runs.md#working-through-the-queue).

## Web mode

```sh
factory serve              # the web app on http://127.0.0.1:4180, plus the worker of `factory work`
factory serve --port 4181 --max-runs 2 --no-open
```

- It does what `factory work` does, and serves a web app for every project in the project list.
- It prints a link with a session token and opens it in your browser (`--no-open` only prints it).
- Its screens are Inbox, Runs, Run details, Backlog and New issue.
- From the Inbox or a run's details you can approve, reject, send a run back, dismiss a code scanning alert or cancel.
- The screens, the actions and how it stays private: [Web mode](web-mode.md).

## Move to another machine

```sh
factory export ~/factory-myrepo.json             # on the first machine; without a file it prints to stdout
factory import ~/factory-myrepo.json --dry-run   # on the other machine: what would be added or changed
factory import ~/factory-myrepo.json
factory sync
```

- It moves the local state `factory sync` can't rebuild to another clone of the same GitHub repo.
- **Finish or cancel a run on the machine that started it**, then export.
- **The snapshot is as trusted as your own database**: keep it out of the repo and only import your own.
- An import still trusts nothing on the file's word: GitHub confirms the issues the factory opened.
- What travels and how import merges: [Moving between machines](moving-between-machines.md).
