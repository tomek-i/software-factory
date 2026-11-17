## Lens: security

Security of the change:

- Injection (shell, SQL, path traversal, template), unsafe deserialisation, SSRF.
- Authentication and authorisation: who can reach the new code, and with what rights.
- Secrets: hard-coded keys or tokens, secrets in logs, error messages or URLs.
- Untrusted input reaching sensitive operations without validation; unsafe defaults.
- New dependencies and their source.

- Trust and config are never read from data a branch, an issue or an imported file can plant.
- Untrusted text (issues, comments, and output derived from them) is framed as data, never followed
  as instructions.
- A child process gets only the environment it needs, and no tokens it does not use.
- Processes and temp files are cleaned up on every path: success, error, timeout, cancel and signal.

Check the change against the project's own security rules too: the repo's `SECURITY.md`, if it has
one, and any security section in the project notes you were given. A change that breaks one of
them is at least major.
