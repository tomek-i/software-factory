# Agent permissions

What each agent may read and write, and what steers it.
Back to the [README](../README.md).

## What steers the agents

- What steers the agents is read from the default branch.
- `factory run` reads `.factory/config.yaml`, `.factory/prompts/<role>.md` and `.factory/lessons.md` from `origin/<default branch>`, not from your working copy.
- So a checked-out branch cannot change its own checks, trust list, gates or prompts.
- Commit and push config changes before they take effect.

## Permissions

- Agents run with `--permission-mode dontAsk` and a per-role allowlist (in `.factory/runs/<run>/agent/`).
- They ignore your own Claude Code settings, hooks and MCP servers (`--setting-sources ""`, `--strict-mcp-config`).
  So nothing outside the profile applies to an agent reading issue text.
- They don't get your GitHub login.
  The engine pushes, opens PRs and merges itself; agents never need to.
  - GitHub tokens (`GH_TOKEN`, `GITHUB_TOKEN`, the enterprise and PAT variants), `SSH_AUTH_SOCK` and `GIT_CONFIG_PARAMETERS` are removed from their environment.
  - `gh` gets an empty config folder of its own, so its GitHub calls are not logged in.
  - git's credential helpers (Git Credential Manager) and askpass program are switched off for them.
  - git never prompts for a login, and ssh may use no key file or agent.
  - So a plain `git push` from an agent's shell has no credentials, over https or ssh.
  - Your git config is not touched.
  - The builder's profile denies `gh` and `git push` outright.
  - This is a barrier, not a sandbox: agents run as you, so one that goes looking can undo it.
    For example `git -c credential.helper=manager push`, or reading your OS keyring (`gh auth token` reads it directly).
    Protect your default branch on GitHub.
- Agent text the factory posts on an issue (the spec, the critic's problems and questions) has its `@mentions` in backticks, so it never notifies anyone.
- The engine, not an agent, runs the app and the browser.
- Bash deny rules are prefix matches, so also protect your default branch on GitHub.

## Roles

A repo can override each role's prompt with the file named here, on its default branch.

- **Triage**: no shell.
  - Reads the repo.
  - Writes only its run folder.
  - Prompt: `.factory/prompts/triage.md`.
- **Refine**: no shell.
  - Reads the repo, which is read-only for it.
  - Writes only its own file in `spec-N/`.
  - Prompt: `.factory/prompts/refine.md`.
- **Spec critic**: no shell.
  - Reads the repo, read-only.
  - Writes only its own file in `spec-N/`, so it cannot rewrite the spec it judges.
  - Prompt: `.factory/prompts/critic.md`.
- **Builder**: has a shell.
  - Works in its own worktree.
  - Edits and runs Bash, but is denied `git push`, `gh pr`, `gh api` and edits to `.factory/`.
  - Prompt: `.factory/prompts/builder.md`.
- **Reviewers**: no shell.
  - Read the change from files the engine writes: `round-N/change.diff`, with the commits and the full diff, written with external diff programs and textconv switched off.
  - Write only their own review file, so one lens cannot change another's verdict.
  - Prompt: `.factory/prompts/reviewer.md` plus `review-<lens>.md`.
- **Verifier**: no shell.
  - Reads the change from `round-N/change.diff`, like the reviewers.
  - Writes only `verify.md`.
  - Prompt: `.factory/prompts/verifier.md`.
- **Approver**: no shell.
  - Reads the change from files the engine writes.
  - Writes only `approval.md`.
  - Prompt: `.factory/prompts/approver.md`.
- **Capture**: no shell.
  - Reads the issue, the triage scope and `round-N/change.diff`.
  - Writes only `capture.md`.
  - Prompt: `.factory/prompts/capture.md`.
- **Learner**: no shell.
  - Reads the run's reports and your decisions (see [Learn](pipeline.md#learn)).
  - Writes only `learn.md`.
  - Prompt: `.factory/prompts/learner.md`.
- **Issue writer**: no shell.
  - Reads the repo, but has no access to `.factory/runs/`, `.worktrees/` or other drafts.
  - Writes only its `draft.md`.
  - Prompt: `.factory/prompts/issue_writer.md`.
