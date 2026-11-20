# Agent permissions

What each agent may write and run, what it is given to read, and what it never gets.
Read this to know what an agent working on untrusted issue text can and can't do on your machine.

## For every agent

- Agents run with `--permission-mode dontAsk` and a per-role allowlist.
- The allowlist is written to `.factory/runs/<run>/agent/`.
- They ignore your own Claude Code settings, hooks and MCP servers (`--setting-sources ""`, `--strict-mcp-config`).
- So nothing outside the allowlist applies to an agent reading issue text.
- The allowlist limits writes, the shell and the web, not reads (see [Read access](#read-access)).
- `ANTHROPIC_API_KEY` is removed from their environment, so runs use your subscription, not API billing.
- They don't get your GitHub login.
- The engine pushes, opens PRs and merges itself; agents never need to.
- Agent text the factory posts on an issue (the spec, the critic's problems and questions) has its `@mentions` in backticks.
- So it never notifies anyone.
- The engine, not an agent, runs the app and the browser.
- The builder's blocked shell commands are matched by how they start, so a reworded command can get through.
  That is one more reason to protect your default branch on GitHub (see [The credential barrier](#the-credential-barrier)).

## The credential barrier

- GitHub tokens (`GH_TOKEN`, `GITHUB_TOKEN`, the enterprise and PAT variants) are removed from their environment.
- `SSH_AUTH_SOCK` and `GIT_CONFIG_PARAMETERS` are removed too.
- `gh` gets an empty config folder of its own, so its GitHub calls are not logged in.
- git's credential helpers (Git Credential Manager) and askpass program are switched off for them.
- git never prompts for a login.
- ssh may use no key file or agent.
- So a plain `git push` from an agent's shell has no credentials, over https or ssh.
- Your git config is not touched.
- The builder's allowlist denies `gh` and `git push` outright.
- This is a barrier, not a sandbox: agents run as you, so one that goes looking can undo it.
  - For example `git -c credential.helper=manager push`.
  - Or reading your OS keyring: `gh auth token` reads it directly.
- Protect your default branch on GitHub.

## Roles

Each role's prompt ships in `packages/core/prompts/<role>.md`.
A repo overrides it with `.factory/prompts/<role>.md` on its default branch.

| Role | Shell | Given | Writes | Prompt |
|---|---|---|---|---|
| Triage | no | the issue and the repo | only its run folder | `.factory/prompts/triage.md` |
| Refine | no | the issue and the repo, read-only | only its own file in `spec-N/` | `.factory/prompts/refine.md` |
| Spec critic | no | the issue, the refined spec and the repo, read-only | only its own file in `spec-N/`, so it cannot rewrite the spec it judges | `.factory/prompts/critic.md` |
| Builder | yes | its worktree; before the merge, the factory's open review notes, framed as data | edits and Bash, but denied `git push`, `gh pr`, `gh api` and edits to `.factory/` | `.factory/prompts/builder.md` |
| Reviewers | no | `round-N/change.diff` and the code around it | only their own review file, so one lens cannot change another's verdict | `.factory/prompts/reviewer.md` plus `review-<lens>.md` |
| Reviewer, acceptance lens | no | `round-N/change.diff`, the code and the engine's numbered acceptance criteria | only `acceptance.md` | `.factory/prompts/reviewer.md` plus `review-acceptance.md` |
| Verifier | no | `round-N/change.diff` and the code | only `verify.md` | `.factory/prompts/verifier.md` |
| Approver | no | the run's reports and `approval.diff` | only `approval.md` | `.factory/prompts/approver.md` |
| Capture | no | the issue, the triage scope and `round-N/change.diff` | only `capture.md` | `.factory/prompts/capture.md` |
| Learner | no | the run's reports, reviews and decisions | only `learn.md` | `.factory/prompts/learner.md` |
| Issue writer | no | your idea and the repo | only its `draft.md`; may not read `.factory/runs/`, `.worktrees/` or other drafts | `.factory/prompts/issue_writer.md` |

- **Given** is what the engine points the role at in its task, not a limit on what it can read.
- Triage can read the repo.
- Reviewers, the verifier and the approver read the change from files the engine writes.
- For reviewers and the verifier that is `round-N/change.diff`, with the commits and the full diff.
- `change.diff` is written with external diff programs and textconv switched off.

## Project notes (CLAUDE.md)

- Agents start with `--setting-sources ""`, so Claude Code does not load the repo's `CLAUDE.md` for them.
- The engine passes the default branch's root `CLAUDE.md` itself, at the end of the role's system prompt.
- It is framed as the project's own notes, for orientation; it does not change the role's rules, permissions or output format.
- Triage, refine, the spec critic, the builder, every reviewer, the verifier and the issue writer get it.
- The approver, capture and the learner don't.
- It is read from `origin/<default branch>`, so a `CLAUDE.md` changed on a run's branch has no effect on that run's agents.
- It is read once per drive, so every agent of a drive gets the same text.
- Without a `CLAUDE.md` (or with an empty one) the prompts are unchanged.
- Over 20,000 characters, it is cut at a line break, with a note saying so.
- Its imports (`@path`) are not followed.
- Other files (`CLAUDE.local.md`, `.claude/CLAUDE.md`, nested ones) are not read.

## Read access

- Every role may read, search and list any file you can (`Read`, `Grep` and `Glob` without a path limit).
- That includes files outside the repo, such as other repos and your home folder.
- The only read limit is the issue writer's: it may not read `.factory/runs/`, `.worktrees/` or other drafts.
- So keep secrets out of files an agent reading untrusted issue text could find.
- The builder can also read anything through its shell.

[All docs](README.md)
