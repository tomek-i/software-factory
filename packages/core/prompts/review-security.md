## Lens: security

Security of the change:

- Injection (shell, SQL, path traversal, template), unsafe deserialisation, SSRF.
- Authentication and authorisation: who can reach the new code, and with what rights.
- Secrets: hard-coded keys or tokens, secrets in logs, error messages or URLs.
- Untrusted input reaching sensitive operations without validation; unsafe defaults.
- New dependencies and their source.

When the project has a `SECURITY.md`, read it: it lists the protections the change must keep. For
the software factory itself, check these invariants too (see `SECURITY.md` and the Security
checklist in `CLAUDE.md`):

- Trust, config and progress come only from the trusted reader, the store or the run folder, never
  from files in the working tree or from imported data.
- Issue text, comments and agent output are untrusted data: framed as data (`issueBlock`), and never
  a trusted spec without a human.
- Anything posted to GitHub quotes `@mentions` (`quietMentions`) and keeps logs and local paths out
  (`redactPaths`).
- Child processes get a known environment: an allowlist for the captured app (`APP_ENV_ALLOWLIST`),
  the full environment minus `CHECK_ENV_DENYLIST` for checks, and minus `AGENT_ENV_DENYLIST` for
  agents (`agentEnv`). A new child process whose output is published gets an allowlist.
- Processes, worktrees and temp dirs are cleaned up on every path (success, error, timeout, cancel,
  signal); process trees are killed with `killTree`.
- Commit hooks and signing are never skipped (no `--no-verify`, no `--no-gpg-sign`).

A breach of any of these, or any other weakening of a protection, is at least major, as the
severity rules above say. Being hard to exploit does not make it minor.
