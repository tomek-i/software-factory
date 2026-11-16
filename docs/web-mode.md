# Web mode

`factory serve`: a local web app over every registered repo.
Back to the [README](../README.md#web-mode) for the commands.

## What it does

- `factory serve` does what `factory work` does: the same picking, limits and stopping (see [Working through the queue](runs.md#working-through-the-queue)).
- `factory stop`, `factory stop --now` and Ctrl+C stop it as they stop `factory work`.
- It serves a web app for every project in the project list.
- It listens on `http://127.0.0.1:4180` unless `--port` says otherwise.
- It prints a link with a session token and opens it in your browser.
- `--no-open` only prints the link.

## Screens

- **Inbox**: runs waiting for you.
  - A run at a gate can be approved (with an optional note) or rejected (with a reason).
  - A run parked for you outside a gate, such as a failed agent, can be resumed to a stage you pick, with a reason.
  - Any of them can be cancelled.
  - A run at the merge gate shows what it would merge: its PR linked with the diff size, the checks on the PR's head, each review lens's verdict with the count of review notes, and its rounds and cost.
  - With a failed check, the failures are listed above the actions and Approve reads "Approve anyway"; it approves as usual.
  - These are read from GitHub only for that card, and a head's finished checks are kept, so GitHub is not asked on every refresh.
  - If GitHub can't be read, the card says so, and the rest of it and its actions still work.
  - The reason "gate is set to human" is left out there, as it only repeats the gate; other reasons stay.
  - Runs waiting for the issue's author are listed below.
  - An approved or resumed run is continued by the worker within a few seconds, as long as its issue is queued.
  - Click a run's title to open its details before deciding.
  - Pending drafts of the issue writer (from the New issue screen or `factory new`) are listed last, each opening its draft.
- **Runs**: the runs going on across projects, live.
  - Each shows its state, round, cost, whether a worker drives it and the agent's latest activity.
  - "All" shows finished runs too.
  - Click a run to open its details.
- **Run details**: what `factory show <run>` prints, in the browser.
  - The issue, with its GitHub link.
  - The gate the run waits at, and the full reason.
  - The verdicts of its run folder: triage, spec, build, checks, reviews with their blocking findings, approval, learn.
  - Its files, each opened as plain text.
  - A run waiting for you can be approved, rejected, resumed or cancelled there, with the Inbox's rules.
  - Run files hold agent output that read untrusted issue text, so the page never renders it as HTML.
  - Local paths in it are shortened: relative to the repo or worktree, and the home folder as `~`.
- **Backlog**: each project's open issues.
  - Each shows its place in the queue, whether the author is trusted and the state of the latest run.
  - Queue and unqueue them from here.
  - "Sync now" pulls issues from GitHub and finishes runs whose PR was merged or closed.
- **New issue**: `factory new` in the browser (see [Writing issues from an idea](factory-new.md)).
  - Pick a project, describe the idea and start the issue writer.
  - Its progress shows live, and it can be stopped.
  - The `issue_writer` gate then decides, as in the CLI: the issues are created on GitHub right away, or the draft waits for you.
  - Issues are queued only if you ticked the box, as with `--queue`.
  - A waiting draft shows its title, UI flag, risk and body as fields, and for a big idea each sub-issue's, with what it depends on.
  - Saving checks the draft as `factory new --approve` does, and refuses a broken edit with the same reasons, leaving the file as it was.
  - Then create it on GitHub (optionally queued), or discard it.
  - A draft git tracks is refused, as in the CLI.
  - A draft that does not parse can only be discarded, or fixed by hand.
  - Drafts are named by their exact id here, not a prefix.
  - One issue writer runs per project at a time; starting another is refused until it ends or is stopped.
- The project picker in the header narrows every screen to one project.
- The actions are the CLI's (`factory approve`, `reject`, `resume`, `cancel`, `queue`, `unqueue`, `sync`, `new`), with the same rules.
- The run details are `factory show <run>`'s.
- Live updates cover the runs `factory serve` itself drives.
- A `factory run` in another terminal shows on the next refresh.

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
- Settings, `--unsafe` and config can't be changed through it.
- The draft routes that read or write draft files take at most 60 requests per 10 seconds each, then answer 429 with `Retry-After`.
