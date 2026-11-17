# Moving between machines

How `factory export` and `factory import` carry local state to another clone of the same GitHub repo.
The commands are in [Using the factory](usage.md#move-to-another-machine).

## Why

- `.factory/factory.db` stays out of git.
- `factory sync` only rebuilds the GitHub side.
- To carry on from another clone of the same GitHub repo (a laptop, then home), move the rest as one JSON file.
- `factory export` with no file prints to stdout.

## What travels

- the queue;
- which issues the factory opened (`factory new`);
- finished runs with their events, decisions and agent runs (costs and tokens included);
- lessons and their decisions;
- what `factory new --approve` has created so far.

## What stays

- Paths, ports, leases and process ids, which only mean something on the machine that wrote them.
- The run folders (`.factory/runs/`).
- Runs that are not finished, including runs waiting for you at a gate.
  - Their worktree, branch and agent session exist only on that machine.
  - `factory export` lists them on stderr.
- **Finish or cancel a run on the machine that started it**, then export.

## How import merges

- **Import merges, never replaces.**
- It matches the project by its GitHub repo, not its folder.
- It refuses a snapshot of another repo or from a newer factory.
- It runs in one transaction, so a failed import changes nothing.
- Importing the same file twice changes nothing the second time.
- `--dry-run` shows what would be added or changed.
- Text from the file it prints (the machine name, the repo it names) shows control characters as `[U+001B]`, so the file cannot send escapes to your terminal.
- Runs:
  - one the database lacks is added with everything attached;
  - one it has is left as it is.
- Queue:
  - when both sides queued an issue, the later queue time wins (queued again means run again);
  - when only one side did, the queued side wins, so an import never drops work;
  - a closed issue is never queued;
  - an imported issue keeps the time it was queued on the other machine, so the worker takes it in turn by that time, not at the end;
  - an issue new to this database is added only when it is queued or the factory opened it, with only its number, state and queue time;
  - an added issue the factory opened but that isn't queued stays unqueued;
  - an issue a run is still working on at export is exported as not queued, so the other machine doesn't start a second run of it; the export says which;
  - their title, body, author, labels and link come from GitHub, never from the file, and show empty until `factory sync` fills them in;
  - `factory run <n>` and the worker fetch such an issue from GitHub before starting a run on it;
  - to unqueue on both machines, unqueue on each.
- Issues the factory opened:
  - an imported "opened by the factory" mark is only a claim, not trust;
  - the next fetch from GitHub (`factory sync`, `factory run <n>` or the worker) settles it;
  - it is kept only if GitHub says the factory's own gh login opened the issue, and dropped otherwise;
  - until then the issue counts as untrusted;
  - so a mark for an issue number that does not exist yet cannot make it trusted when someone opens it.
- Lessons:
  - an approved or rejected lesson wins over a proposed copy;
  - between two decisions, the later one wins.

## Keep the snapshot private

- **The snapshot is as trusted as your own database.**
- Importing it queues issues and claims issues as opened by the factory, which [trusted authors](trust.md#trusted-authors) rely on once GitHub confirms them.
- Keep it outside the repo, in your home or a cloud-sync folder.
- `factory export` warns when the file is inside the working tree.
- `factory export` makes the file readable by you only (mode 600, where the system has it), also when it overwrites one.
- Never commit it to a shared repo.
- Only import a file you exported yourself, never one someone gave you.
- `factory import` reads only the file you name.

[All docs](README.md)
