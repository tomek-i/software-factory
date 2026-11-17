# Writing issues from an idea

How `factory new` turns an idea into GitHub issues.
Back to the [README](../README.md#writing-issues-from-an-idea) for the commands.

## The issue writer

- `factory new` runs an issue writer agent on your idea.
- **Access**: it has no shell. It reads the repo and writes only its draft, `.factory/drafts/<draft>/draft.md`.
- `factory new` adds `.factory/drafts/` to `.gitignore` if it is missing.
- **The draft** is an issue with:
  - a title;
  - `## Why`, `## What` and `## Acceptance criteria` (checkboxes);
  - `## Scope` and `## Out of scope`;
  - a UI flag and a risk rating.
- **Big ideas**: an idea too big for one PR becomes a parent issue plus two or more sub-issues (at most 10).
- Each sub-issue has the same structure.
- **Dependencies**: a sub-issue that needs another first says so with `DEPENDS_ON`.
- That ends up as `Depends on: #n` in its body.
- **Labels**: each issue may have a `LABELS: ui, bug` line, picked from the repo's labels.
- `factory new` reads the labels from GitHub with each draft, so a label you just added is offered.
- The factory's own status labels (`github.label_prefix` and `<prefix>:*`) are never offered.
- A label the repo lacks gets the draft its retry.
- If the labels can't be read, the draft has none, and a line says why.
- **Checks**: the draft is checked strictly.
- A malformed draft gets one retry, then it is kept for you to fix or discard.
- `<draft>` in the commands is a draft id or a unique prefix of one.

## The issue_writer gate

- `human` (default): the draft is printed and saved, and the command exits.
  - Edit `draft.md` if you like, then `factory new --approve <draft>` creates it.
  - The file is read and checked again first.
- `auto`: the agent's own `DECISION: PROCEED` creates it straight away.
  - `ESCALATE` waits for you as with `human`, with its reasons.
- `always`: created straight away.

With `auto` or `always`, nobody reads the draft before it becomes an issue:

- It becomes a trusted issue (see [Trusted authors](trust.md#trusted-authors)), so later stages treat it as the spec.
- The issue writer cannot read run folders (`.factory/runs/`), worktrees or other drafts.
- So text from untrusted issues does not reach it that way. But it does read the repo.
- Keep the default `human` unless you trust what is in your repo.

## Creating a draft

- It always prints the full draft first.
- It opens the issues on GitHub, with their labels.
- If any issue has labels, they are read and checked again first, as you may have edited them.
- A label the repo lacks, or a status label, refuses the draft before anything is created.
- It links each sub-issue to the parent as a real GitHub sub-issue.
- It syncs them into `.factory/factory.db`.
- With `--queue` only, it queues the buildable ones: the single issue, or the sub-issues (never their parent).
- It prints the numbers, and the `factory queue` and `factory run` commands to queue or start them.
- Without `--queue`, nothing is queued.
- So `factory work` and `factory serve` leave the new issues alone until you queue them.
- The `--queue` choice is not saved with a draft that waits for you.
- Pass `--queue` again with `--approve` (the hint shows the command).

## If something goes wrong

- What has been created is recorded in `.factory/factory.db`.
- If GitHub fails halfway, `factory new --approve` again only does what is left.
- An issue whose draft entry you edited after it was created is refused, rather than matched up by position.
- If `gh issue create` succeeds but its output can't be read, the error names the title.
- Check GitHub before approving again, as that issue may exist already.
- A draft with files that git tracks is refused.
- `factory new` only writes ignored files, so such a draft came from a commit, possibly someone else's branch.
