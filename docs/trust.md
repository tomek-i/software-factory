# Trust

Anyone who can open an issue can write text the agents will read.
This page covers whose text the factory treats as the spec, and what happens to everyone else's.

## Trusted authors

```yaml
trust:
  authors: ["your-handle", "teammate"]   # init pre-fills your own gh login
  everyone: false                        # true for private repos where only approved people open issues
```

- **Trusted** issues and comments are treated as the spec.
- **Untrusted** ones (e.g. strangers on a public repo) can still be queued, but:
  - their text is handled as untrusted data;
  - triage always waits for your approval before anything is built, also after a restart, even with `factory run <n>`;
  - the run always waits for you at the `critic` gate before build, and the spec reaches the builder marked as untrusted;
  - `factory issues` marks them `(untrusted)`.
- For a trusted author, your approval at the triage gate carries over when a restarted run triages the unchanged issue again (see [Triage again after a restart](pipeline.md#triage-again-after-a-restart)).
- **Issues the factory created** with `factory new` are trusted, whoever the gh login is.
  - They were written from your own idea and approved by you (or by the gate you configured).
  - The factory records this locally when it creates them, so a later `factory sync` never clears it and nobody on GitHub can set it.
  - Comments on them by others are still judged by their own author.
- On an issue the factory's gh account wrote, refine puts its spec in the issue body (see [Refine](pipeline.md#refine)).
  - A later triage reads that agent-written section with the rest of the issue, at the issue's trust.
  - Only the factory's own issues are edited, so an untrusted author's text never becomes part of a trusted issue this way.
- Review threads on a run's PR are judged by who started them.
  - With `merge.open_feedback: fix`, only threads by trusted authors and by the apps in `merge.comment_bots` go to the builder without you.
  - Anyone else's wait for you. See [Open review threads and failed checks](pipeline.md#open-review-threads-and-failed-checks).
- The trust list is read from the default branch, so a branch can't change it (see [What steers the agents](configuration.md#what-steers-the-agents)).
- An imported snapshot can queue issues and claim them as opened by the factory (see [Moving between machines](moving-between-machines.md)).
  - A claim counts only once GitHub says the factory's own gh login opened the issue.
  - An issue new to the database is fetched from GitHub before a run uses its text or author.

[All docs](README.md)
