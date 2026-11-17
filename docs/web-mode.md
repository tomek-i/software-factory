# Web mode

`factory serve` runs the worker and a local web app over every registered repo.
This page covers what each screen shows, what you can do there, and how the app stays private.
The commands are in [Using the factory](usage.md#web-mode).

## What it does

- `factory serve` does what `factory work` does: the same picking, limits and stopping (see [Working through the queue](runs.md#working-through-the-queue)).
- `factory stop`, `factory stop --now` and Ctrl+C stop it as they stop `factory work`.
- It serves a web app for every project in the project list.
- It listens on `http://127.0.0.1:4180` unless `--port` says otherwise.
- It prints a link with a session token and opens it in your browser.
  `--no-open` only prints the link.
- The project picker in the header narrows every screen to one project.
- The actions are the CLI's (`factory approve`, `reject`, `resume`, `checks`, `dismiss`, `cancel`, `queue`, `unqueue`, `sync`, `new`), with the same rules.
- Live updates cover the runs `factory serve` itself drives.
  A `factory run` in another terminal shows on the next refresh.

## Screens

### Inbox

The runs waiting for you.
Runs waiting for the issue's author are listed below them, and pending drafts of the issue writer last.

- Click a run's title to open its details before deciding.
- An approved or resumed run is continued by the worker within a few seconds, as long as its issue is queued.

What you can do with a waiting run:

- **Approve** (with an optional note) or **Reject** (with a reason) a run at a gate.
- **Send back to…** an earlier working stage (refine, build or review, whichever come before the gate), with a message.
  It is hidden at a gate with none before it (triage).
- **Resume** a run parked outside a gate, such as a failed agent, to a stage you pick, with a reason.
  - Each target says what happens and what runs again.
  - Picking intake or triage warns that triage, the spec critic and the build all run again, at a cost.
  - **Reset loop counters** gives the build, review, spec and re-sync loops a fresh budget, as `--reset-loops` does.
    It starts ticked when a loop cap stopped the run, and says which: without it the run stops again at once.
- **Send to builder with this failure**, when the run waits on something concrete: failed required checks, a failed quality gate, or findings the verifier confirmed.
  - It opens the form with target build, the counters reset, and the failure as the message: check name, summary, link, file and line where known.
  - For a failed code scanning check the message lists its open alerts, e.g. `CodeQL: Missing rate limiting (js/missing-rate-limiting) at apps/server/src/drafts.ts:296 (link)`.
  - Everything in it can be edited before sending.
- **Failed checks…** lists the required checks that failed on the run's PR (see [When a required check fails](runs.md#when-a-required-check-fails)).
  - A code scanning check lists its open alerts, each with **Dismiss…**: one of GitHub's reasons and a required comment.
  - Once no required check fails, the run goes back to merge; otherwise it keeps waiting.
  - Any other failed required check can only go to the builder.
- **Cancel run**, for any waiting run.
  A run whose issue was closed on GitHub while its PR is still open says so; cancelling it also closes the PR and deletes its branch.

### The merge-gate card

A run waiting at the merge gate shows what it would merge:

- its PR, linked, with the diff size;
- the checks on the PR's head;
- each review lens's verdict, with the count of review notes;
- its rounds and cost.

Then:

- With a failed check, the failures are listed above the actions, and Approve reads **Approve anyway**. It approves as usual.
- With open review threads or failed optional checks, Approve reads **Merge anyway** (see [Open review threads and failed checks](pipeline.md#open-review-threads-and-failed-checks)).
- These are read from GitHub only for that card, and a head's finished checks are kept, so GitHub isn't asked on every refresh.
- If GitHub can't be read, the card says so, and the rest of it and its actions still work.
- The reason "gate is set to human" is left out there, as it only repeats the gate; other reasons stay.

### Runs

The runs going on across projects, live.

- Each shows its state, round, cost, whether a worker drives it and the agent's latest activity.
- "All" shows finished runs too.
- Click a run's title to open its details.

### Run details

What `factory show <run>` prints, in the browser.

- The issue, with its GitHub link.
- The gate the run waits at, and the full reason.
- The verdicts of its run folder: triage, spec, build, checks, reviews with their blocking findings, approval, learn.
- Its files, each opened as plain text.
  They hold agent output that read untrusted issue text, so the page never renders it as HTML.
  - Screenshots, videos and other files with no text are listed but not opened; open them from the run folder.
  - A file over 1 MB is not shown either; `factory show <run> <file>` prints it.
- Local paths in it are shortened: relative to the repo or worktree, and the home folder as `~`.
- A run waiting for you has the same actions as in the Inbox, and says what was done once it went through.

### Backlog

Each project's open issues.

- Each shows its place in the queue, whether the author is trusted and the state of the latest run.
- Queue and unqueue them from here.
- "Sync now" pulls issues from GitHub and finishes runs whose PR was merged or closed, or whose issue was closed (see [Merging or closing on GitHub](runs.md#merging-or-closing-on-github)).

### New issue

`factory new` in the browser, with the same rules (see [Writing issues from an idea](factory-new.md)).

- Pick a project, describe the idea and start the issue writer.
- Its progress shows live, and it can be stopped.
- The `issue_writer` gate then decides: the issues are created on GitHub right away, or the draft waits for you.
- Issues are queued only if you ticked the box, as with `--queue`.
- A waiting draft shows its fields (title, UI flag, risk, labels, body, and each sub-issue's with what it depends on) for you to edit.
- Saving checks the draft as `factory new --approve` does; a broken edit is refused and the file stays as it was.
- Then create it on GitHub (optionally queued), or discard it.

Differences from the CLI:

- Drafts are named by their exact id, not a prefix.
- One issue writer runs per project at a time; starting another is refused until it ends or is stopped.
- A draft that doesn't parse can only be discarded, or fixed by hand.

## Security

The server can start agents and merge pull requests, so it answers only your own browser:

- it listens on 127.0.0.1;
- it refuses requests whose `Host` isn't its own address;
- it needs the session token from the printed link on every API call;
- it takes changes only from its own page (`Origin`).

The session token:

- It is in the link's `#` part, which never reaches a server.
- The page keeps it (in this browser's storage for that address) and sends it in a header.
- So no other site or local server gets it.
- A new `factory serve` prints a new link.

Other limits:

- A decision is refused when the run has moved on since the page showed it.
  - That covers sending back, resetting loops and dismissing an alert too.
- Settings, `--unsafe` and config can't be changed through it.
- The draft routes that read or write draft files take at most 60 requests per 10 seconds each, then answer 429 with `Retry-After`.

[All docs](README.md)
