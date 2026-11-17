# Trust

Whose text the agents treat as the spec, and the optional status labels.
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
  - triage always waits for your approval before anything is built, also after a restart;
  - the run always waits for you at the `critic` gate before build, and the spec reaches the builder marked as untrusted;
  - `factory issues` marks them `(untrusted)`.
- `factory run <n>` on an issue by an author outside `trust.authors` still waits for you at triage.
- For a trusted author, your approval at the triage gate carries over when a restarted run triages the unchanged issue again (see [Triage again after a restart](pipeline.md#triage-again-after-a-restart)).
- **Issues the factory created** with `factory new` are trusted, whoever the gh login is.
  - They were written from your own idea and approved by you (or by the gate you configured).
  - The factory records this locally when it creates them, so a later `factory sync` never clears it and nobody on GitHub can set it.
  - Comments on them by others are still judged by their own author.
- On an issue the factory's gh account wrote, refine puts its spec in the issue body (see [Refine](pipeline.md#refine)).
  - A later triage reads that agent-written section with the rest of the issue, at the issue's trust.
  - Only the factory's own issues are edited, so an untrusted author's text never becomes part of a trusted issue this way.
- Review threads on a run's PR are judged by who started them: with `merge.open_feedback: fix`, only trusted authors' threads and those of the apps in `merge.comment_bots` go to the builder without you (see [Open review threads and failed checks](pipeline.md#open-review-threads-and-failed-checks)).
- The trust list is read from the default branch, so a branch cannot change it (see [What steers the agents](runs.md#what-steers-the-agents)).
- An imported snapshot can queue issues and claim them as opened by the factory (see [Moving between machines](moving-between-machines.md)).
  - A claim counts only once GitHub says the factory's own gh login opened the issue.
  - An issue new to the database is fetched from GitHub before a run uses its text or author.

## Status labels

- They are optional and off by default.
- With `github.status_labels: true`, the factory mirrors run status onto the issue.
- The labels are `factory`, `factory:in-progress`, `factory:needs-info`, `factory:needs-human` and `factory:unsafe`.
- `github.label_prefix` sets the prefix (default `factory`).
- They are display-only and never read as input.
- Work is picked locally, never from GitHub labels, so nobody on GitHub can feed issues into your factory.
- `factory init --labels` turns them on and creates the labels.
  If you enable them by hand instead, run `factory init` again to create the labels.
