## Lens: security

Security of the change:

- Injection (shell, SQL, path traversal, template), unsafe deserialisation, SSRF.
- Authentication and authorisation: who can reach the new code, and with what rights.
- Secrets: hard-coded keys or tokens, secrets in logs, error messages or URLs.
- Untrusted input reaching sensitive operations without validation; unsafe defaults.
- New dependencies and their source.

The factory's own invariants, for code that runs agents, reads issues or posts to GitHub:

- Trust, config and progress come only from a source a branch or an imported file cannot plant:
  the default branch through the trusted reader, the store or the run folder, never the working
  tree.
- Issue text, comments and agent output derived from them are framed as data, never followed as
  instructions, and never become a trusted spec without a human.
- Anything posted to GitHub has its `@mentions` quoted (`quietMentions`) and logs and local paths
  removed (`redactPaths`).
- A child process gets only the environment it needs: an allowlist when its output is published,
  and no tokens for checks or agents.
- Processes, worktrees and temp folders are cleaned up on every path: success, error, timeout,
  cancel and signal.

If the repo has a `SECURITY.md`, read it: it lists the protections the project relies on. A change
that breaks one of these invariants or one of those protections is at least major.
