# Media hosting

Where the capture stage's screenshots and videos go.
Back to the [README](../README.md); the capture stage itself is in [Pipeline: Capture and PR](pipeline.md#capture-and-pr).

## Where the media goes

- It is attached to the run's PR, the way dragging a file into a GitHub comment box does.
- It is never committed.
- GitHub has no API for attachments, so the engine does it in a headless browser signed in to GitHub.
- Sign that browser in once with `factory login github`.
- Run `factory login github` again to check who is signed in.
- The browser keeps its own profile:
  - on Windows in `%LOCALAPPDATA%\software-factory\github-browser`;
  - elsewhere in `~/.config/software-factory/github-browser` (`$XDG_CONFIG_HOME`).
- `FACTORY_DATA_DIR` moves the profile.
- The profile holds your GitHub session, so it gives access to your account: keep it private.
- The profile is never in a repository.
- The comment is never posted.
- Each upload leaves a `github.com/user-attachments/...` link, and the engine empties the box again.
- The PR shows the media to everyone who can see the repo: anyone for a public repo, only people with access for a private one.
- GitHub serves each viewer a signed link from the PR page.
- The bare `user-attachments` link itself only opens for signed-in users.
- Videos play inline in the PR.
- Limits: 10 MB per image, 100 MB per video.
- GitHub's free plans refuse videos over 10 MB.
- Attachments cannot be deleted, so they stay when a run ends without merging.
- Files uploaded before an upload failed stay too.
- Nothing links to them then.
- Runs in one factory process take turns with the browser.
- While `factory login github` has the browser open, a run's upload goes to the draft release instead.
- The media also lives in the run folder (`round-N/capture/`).

## When it cannot be attached

- The media then goes to a **draft** GitHub release, `factory-media-<run>`, instead.
- That happens when:
  - the browser is not signed in (or the session expired);
  - GitHub's page changed;
  - a file is too big;
  - the run has no PR.
- The PR says why in a fixed phrase, never the browser's own error, which can name local paths.
- The full error is in `capture-report.md`.
- The PR also says that only maintainers can see the media.
- A draft's assets are only served to people with push access to the repo, signed in to GitHub.
- A draft creates no git tag, fires no `release` or tag workflows and notifies no one.
- The factory never publishes it.
- `factory reject` and `factory cancel` delete the run's release, or print the `gh release delete` command if that fails.
- A merged run keeps its release, since its PR links to it.
- A run that ends because its PR was closed on GitHub keeps it too.
- Delete it with `gh release delete factory-media-<run> --yes`.
