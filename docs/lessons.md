# Lessons

How the factory learns from its runs.
Back to the [README](../README.md); the learner itself is in [Pipeline: Learn](pipeline.md#learn).

```sh
factory lessons                    # lessons the learner proposed, waiting for you; -a/--all includes approved and rejected ones
factory lessons approve 3 4        # open one PR that appends these lessons to .factory/lessons.md
factory lessons reject 5 -m "why"  # never apply this lesson; -m is optional
```

## Proposed lessons

- `.factory/lessons.md` is put in front of every agent's task as "Lessons from earlier runs".
- `factory init` writes the file.
- After a run with something to learn from, the learner proposes lessons.
- `factory status` says when some are waiting (`3 lessons waiting: factory lessons`).
- `factory lessons` lists each one with its id, the run it came from, the rule, what went wrong and the evidence.

## Approving

`factory lessons approve <id...>` opens **one PR** for all the lessons you name.

- The engine (not an agent) creates `factory/lessons-<timestamp>` from the freshly fetched `origin/<default branch>` in a temporary worktree.
- The worktree is removed afterwards, and your working copy is not touched.
- It appends each rule as a `- ` line to `.factory/lessons.md`, commits and pushes.
- It opens a ready-for-review PR listing each lesson and its run.
- While a lessons PR is still open, later approvals go onto its branch and update its description instead.
- That is because two PRs that both append to the end of the file would conflict.
- The lessons are marked approved, with the PR number, only once they are on the PR.
- If a PR cannot be opened, the pushed branch is deleted and nothing is approved.
- Because agents read lessons from the default branch, an approved lesson takes effect when you merge that PR.

## Commit hooks and signing

- The lessons commit runs your repository's own commit hooks and signing.
- They are never skipped.
- A hook that needs something a fresh worktree lacks (husky without `node_modules`, say) refuses the commit.
- So does signing that cannot run without a prompt.
- `factory lessons approve` then says a commit hook or signing refused it, and the lessons stay proposed.
- Each git command there is stopped after 5 minutes.

## Rules for a lesson

- A rule must be one line of at most 300 characters.
- It may not hold control or text-direction characters.
- `factory lessons` shows any such character in a lesson as `[U+XXXX]` rather than printing it.

## Rejecting

- `factory lessons reject <id...> -m "why"` marks them rejected.
- They are kept with your reason and never applied.
