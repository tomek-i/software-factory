# factory new

Writing issues from an idea.
The commands are in the [README](../README.md#writing-issues-from-an-idea).

## The issue writer

`factory new` runs an issue writer agent on your idea.

- **Access**: it has no shell.
  - It reads the repo and writes only its draft, `.factory/drafts/<draft>/draft.md`.
  - `factory new` adds `.factory/drafts/` to `.gitignore` if it is missing.
- **The draft** is an issue with a title, `## Why`, `## What`, `## Acceptance criteria` (checkboxes), `## Scope` and `## Out of scope`, a UI flag and a risk rating.
- **Big ideas**: an idea too big for one PR becomes a parent issue plus two or more sub-issues (at most 10), each with the same structure.
- **Dependencies**: a sub-issue that needs another first says so with `DEPENDS_ON`.
  That ends up as `Depends on: #n` in its body.
- **Checks**: the draft is checked strictly.
  A malformed one gets one retry, then it is kept for you to fix or discard.
- `<draft>` is a draft id or a unique prefix of one.

## The issue_writer gate

The `issue_writer` gate then decides:

- `human` (default): the draft is printed and saved, and the command exits.
  - Edit `draft.md` if you like, then `factory new --approve <draft>` creates it.
  - The file is read and checked again first.
- `auto`: the agent's own `DECISION: PROCEED` creates it straight away.
  `ESCALATE` waits for you as above, with its reasons.
- `always`: created straight away.

With `auto` or `always`, nobody reads the draft before it becomes an issue:

- It becomes a trusted issue (see [Trusted authors](trust.md#trusted-authors)), so later stages treat it as the spec.
- The issue writer cannot read run folders (`.factory/runs/`), worktrees or other drafts, so text from untrusted issues does not reach it that way.
  But it does read the repo.
- Keep the default `human` unless you trust what is in your repo.

## Creating a draft

Creating a draft:

- always prints the full draft first;
- opens the issues on GitHub (no labels);
- links each sub-issue to the parent as a real GitHub sub-issue;
- syncs them into `.factory/factory.db`;
- queues the buildable ones: the single issue, or the sub-issues (never their parent);
- prints the numbers and the `factory run` command to start them.

## If something goes wrong

- What has been created is recorded in `.factory/factory.db`.
  If GitHub fails halfway, `factory new --approve` again only does what is left.
- An issue whose draft entry you edited after it was created is refused, rather than matched up by position.
- If `gh issue create` succeeds but its output can't be read, the error names the title.
  Check GitHub before approving again, as that issue may exist already.
- A draft with files that git tracks is refused.
  `factory new` only writes ignored files, so such a draft came from a commit, possibly someone else's branch.
