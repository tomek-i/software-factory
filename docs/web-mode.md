# Web mode

`factory serve`: a local web app over every registered repo.
The commands are in the [README](../README.md#web-mode).

## What it does

- `factory serve` does what `factory work` does: the same picking, limits and stopping (`factory stop`, `factory stop --now`, Ctrl+C).
  See [Worker](worker.md).
- It also serves a web app for every project in the project list.
- It prints a link with a session token and opens it in your browser (`--no-open` only prints it).

## Screens

- **Inbox**: runs waiting for you.
  - A run at a gate can be approved (with an optional note) or rejected (with a reason).
  - A run parked for you outside a gate, such as a failed agent, can be resumed to a stage you pick, with a reason.
  - Any of them can be cancelled.
  - Runs waiting for the issue's author are listed below.
  - An approved or resumed run is continued by the worker within a few seconds, as long as its issue is queued.
- **Runs**: the runs going on across projects, live.
  - Each shows its state, round, cost, whether a worker drives it and the agent's latest activity.
  - "All" shows finished runs too.
- **Backlog**: each project's open issues.
  - Each shows its place in the queue, whether the author is trusted and the state of the latest run.
  - Queue and unqueue them.
  - "Sync now" pulls issues from GitHub and finishes runs whose PR was merged or closed.
- The project picker in the header narrows every screen to one project.
- The actions are the CLI's (`factory approve`, `reject`, `resume`, `cancel`, `queue`, `unqueue`, `sync`) with the same rules.
- `factory show <run>` has a run's details.
- Live updates cover the runs `factory serve` itself drives.
  A `factory run` in another terminal shows on the next refresh.

## Security

The server can start agents and merge pull requests, so it answers only your own browser:

- it listens on 127.0.0.1;
- it refuses requests whose `Host` isn't its own address;
- it needs the session token from the printed link on every API call;
- it takes changes only from its own page (`Origin`).

More rules:

- The token is in the link's `#` part, which never reaches a server.
  - The page keeps it (in this browser's storage for that address) and sends it in a header.
  - So no other site or local server gets it.
- A decision is refused when the run has moved on since the page showed it.
- A new `factory serve` prints a new link.
- Settings, `--unsafe` and config can't be changed through it.
