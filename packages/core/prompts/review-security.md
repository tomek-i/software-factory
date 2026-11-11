## Lens: security

Security of the change:

- Injection (shell, SQL, path traversal, template), unsafe deserialisation, SSRF.
- Authentication and authorisation: who can reach the new code, and with what rights.
- Secrets: hard-coded keys or tokens, secrets in logs, error messages or URLs.
- Untrusted input reaching sensitive operations without validation; unsafe defaults.
- New dependencies and their source.
