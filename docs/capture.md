# Capture

Where the screenshots and videos of a UI change go, and how the narrated walkthrough is made.
The capture stage itself is in [Pipeline: Capture and PR](pipeline.md#capture-and-pr).
Back to the [README](../README.md).

## Requirements

- Playwright's Chromium, for screenshots and videos of UI changes.
  - `pnpm install` installs the `playwright` package (an optional dependency) but never downloads browsers.
  - Run `pnpm exec playwright install chromium` once in the factory's checkout.
  - Without it the capture stage is skipped with a note and runs carry on.
- If the factory's own `playwright` package is missing, the copy the [narrate](https://github.com/tomek-i/narrate-plugin) Claude Code plugin ships with is used, as far as `app.narrate` allows:
  - with `auto` (the default), the newest plugin in the cache;
  - with a path to `narrate.mjs`, only the plugin that path belongs to;
  - with `off`, not at all.
- Optional, so everyone can see the screenshots and videos in the factory's PRs: run `factory login github` once (see [Signing in to GitHub](#signing-in-to-github)).
- Optional, for a narrated walkthrough: the narrate Claude Code plugin and `ffmpeg` on PATH (see [Narrated walkthrough](#narrated-walkthrough)).

## Signing in to GitHub

- `factory login github` opens a browser and waits for you to sign in to GitHub there.
- The factory then attaches screenshots and videos to its PRs.
- Run it again to check who is signed in.

## Where the media goes

- It is attached to the run's PR, the way dragging a file into a GitHub comment box does, and never committed.
- GitHub has no API for attachments, so the engine does it in a headless browser signed in to GitHub.
  Sign it in once with `factory login github`.
- The browser keeps its own profile in `%LOCALAPPDATA%\software-factory\github-browser` on Windows.
  Elsewhere it is `~/.config/software-factory/github-browser` (`$XDG_CONFIG_HOME`).
  - `FACTORY_DATA_DIR` moves it.
  - It holds your GitHub session, so it gives access to your account: keep it private.
  - It is never in a repository.
- The comment is never posted.
  Each upload leaves a `github.com/user-attachments/...` link, and the engine empties the box again.
- The PR shows them to everyone who can see the repo: anyone for a public repo, only people with access for a private one.
  - GitHub serves each viewer a signed link from the PR page.
  - The bare `user-attachments` link itself only opens for signed-in users.
  - Videos play inline in the PR.
- Limits: 10 MB per image, 100 MB per video (GitHub's free plans refuse videos over 10 MB).
- Attachments cannot be deleted, so they stay when a run ends without merging, and so do files uploaded before an upload failed.
  Nothing links to them then.
- Runs in one factory process take turns with the browser.
- While `factory login github` has it open, a run's upload goes to the draft release instead.
- It lives in the run folder (`round-N/capture/`) and on GitHub.
- The PR description gets a `## Screenshots` section with a before/after table, the video and the new errors, above the review notes.

## When it cannot be attached

- It goes to a **draft** GitHub release, `factory-media-<run>`, instead, when:
  - the browser is not signed in (or the session expired);
  - GitHub's page changed;
  - a file is too big;
  - or the run has no PR.
- The PR says why in a fixed phrase, never the browser's own error, which can name local paths.
  The full error is in `capture-report.md`.
- The PR also says that only maintainers can see the media: a draft's assets are only served to people with push access to the repo, signed in to GitHub.
- A draft creates no git tag, fires no `release` or tag workflows and notifies no one.
- The factory never publishes it.
- `factory reject` and `factory cancel` delete the run's release, or print the `gh release delete` command if that fails.
- A merged run keeps it, since its PR links to it.
- A run that ends because its PR was closed on GitHub keeps it too: delete it with `gh release delete factory-media-<run> --yes`.

## Narrated walkthrough

- The capture agent can give walkthrough steps a `say`: one spoken sentence, at most 300 characters, one line.
- With at least one `say`, the narrate plugin (0.24.0 or newer) installed and `ffmpeg` on PATH, the engine records the walkthrough again with a voice, as `walkthrough-narrated.mp4`.
- It calls the plugin's own CLI (`bin/narrate.mjs render`) as a plain command, never as a plugin inside an agent: agents run without plugins or MCP servers.
- `app.narrate` picks it:
  - `auto` (default) takes the newest version in `~/.claude/plugins/cache/*/narrate/`;
  - `off` turns narration off;
  - anything else is a path to `narrate.mjs`, for example narrate's own stable launcher, `~/.narrate/bin/narrate.mjs`, written by `narrate setup`.
- The engine builds narrate's scene from the validated steps only, as URLs on the app's origin, and renders it with `--untrusted`.
  - narrate then refuses `eval`, `uploadFile` and other sites.
  - It types `${NAME}` in a fill value as written.
  - It stops without a video if the app sends the browser to another origin.
- It narrates only after the silent walkthrough went through every step.
  So a walkthrough that fails is not spoken (and, with a cloud voice, paid for) first.
- The CLI gets the app's minimal environment plus `PLAYWRIGHT_BROWSERS_PATH`, `NARRATE_HOME`, `NARRATE_GEMINI_API_KEY` and `NARRATE_ELEVENLABS_API_KEY`.
- Voice and keys otherwise come from narrate's own settings (`~/.narrate/settings.json`, set up with `/narrate-setup`; default the OS voice).
- A key in a custom `apiKeyEnv` variable is not passed.
- It runs in `round-N/capture/narrate/`: the scene, narrate's own `narrate.log`, and its progress output in `cli-output.log`.
- The engine reads the video from narrate's `--json` result, which also refuses a video without a voice.
- It is stopped with its whole process tree after 10 minutes, on a cancel or when the factory exits.
- It never fails the run.
- The PR links the narrated video instead of the silent one, and only that one is uploaded.
- Without the plugin the silent video is used and nothing is said about it.
- A narration that was tried and failed is noted in the PR and the report.
