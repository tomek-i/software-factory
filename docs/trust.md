# Trust

Whose issues and comments count as the spec, and the optional status labels.
Back to the [README](../README.md).

## Trusted authors

Anyone who can open an issue can write text the agents will read, so the factory distinguishes trusted authors:

```yaml
trust:
  authors: ["your-handle", "teammate"]   # init pre-fills your own gh login
  everyone: false                        # true for private repos where only approved people open issues
```

- **Trusted** issues and comments are treated as the spec.
- **Untrusted** ones (e.g. strangers on a public repo) can still be queued, but:
  - their text is handled as untrusted data;
  - triage always waits for your approval before anything is built;
  - `factory issues` marks them `(untrusted)`.
- **Issues the factory created** with `factory new` are trusted, whoever the gh login is.
  - They were written from your own idea and approved by you (or by the gate you configured).
  - The factory records this locally when it creates them, so a later `factory sync` never clears it and nobody on GitHub can set it.
  - Comments on them by others are still judged by their own author.

## Status labels

- Status labels are optional.
- With `github.status_labels: true`, the factory mirrors run status onto the issue: `factory`, `factory:in-progress`, `factory:needs-info`, `factory:needs-human`, `factory:unsafe`.
- They are display-only and never read as input.
- Run `factory init` again after enabling them to create the labels.
