# Capture

How the factory shows a UI change in its PR: screenshots before and after, a walkthrough video, and where they are stored.
To turn it on, tell the factory how to start your app ([Configuration: app](configuration.md#app)).

## When it runs

- Capture runs when triage marked the change as visible in the UI, and `app.start` is set.
- Otherwise it passes straight on, with an info line saying why.
- Nothing here fails the run (see [below](#nothing-here-fails-the-run)).

## Playwright and Chromium

- Installing the factory installs the `playwright` package (an optional dependency), but never downloads browsers.
- Download Chromium once with the factory's own Playwright, so the browser build matches it:
  - npm install (PowerShell or bash): `cd "$(npm root -g)/@tomek-i/software-factory"`, then `npx playwright install chromium`;
  - source checkout: `pnpm exec playwright install chromium`.
- A bare `npx playwright` elsewhere fetches the latest Playwright, whose browser the factory can't use.
- If the factory's own `playwright` package is missing, the copy the [narrate](https://github.com/tomek-i/narrate-plugin) plugin ships with is used, as far as `app.narrate` allows:
  - with `auto` (the default), the newest plugin in the cache;
  - with a path to `narrate.mjs`, only the plugin that path belongs to;
  - with `off`, not at all.
- Without a browser, capture is skipped with a note and the run carries on.

## The plan

- A capture agent (no shell, writes only `round-N/capture.md`) reads the issue, the triage scope and `round-N/change.diff`.
- It writes a plan:
  - the pages to shoot (at most 10), each marked `new` (the change adds it) or `existing` (it changes);
  - an optional walkthrough drawn from the acceptance criteria.

## The walkthrough

- It is a fixed list of declarative steps: `goto` a path, `click` a selector or text, `fill` a selector, `wait`, `screenshot`.
- The engine validates and runs it.
- Nothing an agent writes is ever run as code.
- Every path must be on the app's own origin, and the browser never leaves it.
- Requests to other origins are blocked.
- A redirect to another origin is stopped before it is followed.
- A page or step that still ends up elsewhere is not shot.
- If the walkthrough leaves the app, it stops there and its video is discarded, as it may show a page outside the app.

## Clean worktree only

- Capture only starts the app on a clean worktree.
- If the worktree has uncommitted changes (for example your own edits in a run you resumed), the stage says so.
- It then goes on without screenshots, leaving the changes alone.

## Starting the app

- The engine starts `app.start` in the run's worktree on a free port, passed in `app.port_env`.
- The app gets a minimal environment, not yours:
  - only what a shell, Node and package managers need (`PATH`, `SystemRoot`, `HOME`/`USERPROFILE`, `TEMP`, `APPDATA`, `LANG`, `NODE_ENV` and the like);
  - the port;
  - `BROWSER=none`;
  - the variables named in `app.env`.
- Tokens (`ANTHROPIC_API_KEY`, `GH_TOKEN`, `GITHUB_TOKEN`) are refused even there.
- Its pages are published, so nothing they render should come from your environment.
- The engine waits up to `app.ready_timeout_sec` for `app.url` to answer.
- The factory does not install dependencies for the app.
- Put the install step in `app.start` if it needs one (e.g. `npm ci && npm run dev`).
  The before shots come from a fresh checkout, with nothing installed.

## Shooting

- Playwright shoots every page at 1440 and 390 px wide.
- It records console errors, page errors, failed requests and 4xx/5xx responses.
- Then it records the walkthrough as `walkthrough.webm` (WebM, since MP4 would need ffmpeg).

## Before shots

- For `existing` pages it does the same in a temporary worktree of the freshly fetched `origin/<default branch>`.
- That worktree is removed again afterwards.
- `new` pages get no before shots, and the report says so.
- Errors only the change's version has are reported as new.

## Cleaning up

- Each server's whole process tree is killed when it is done with.
- That also happens on errors, timeouts, cancels and when the factory exits.
- Anything the app writes into the run's worktree that git does not ignore is undone, so the branch stays clean.

## Narrated walkthrough

- The capture agent can give walkthrough steps a `say`: one spoken sentence, at most 300 characters, one line.
- With at least one `say`, the narrate plugin (0.24.0 or newer) installed and `ffmpeg` on PATH, the engine records the walkthrough again with a voice.
- The narrated recording is `walkthrough-narrated.mp4`.
- The engine calls the plugin's own CLI (`bin/narrate.mjs render`) as a plain command, never as a plugin inside an agent.
- Agents run without plugins or MCP servers.
- `app.narrate` picks the plugin:
  - `auto` (default) takes the newest version in `~/.claude/plugins/cache/*/narrate/`;
  - `off` turns narration off;
  - anything else is a path to `narrate.mjs`;
    - for example narrate's own stable launcher, `~/.narrate/bin/narrate.mjs`, written by `narrate setup`.
- The engine builds narrate's scene from the validated steps only, as URLs on the app's origin.
- It renders the scene with `--untrusted`. Narrate then:
  - refuses `eval`, `uploadFile` and other sites;
  - types `${NAME}` in a fill value as written;
  - stops without a video if the app sends the browser to another origin.
- It narrates only after the silent walkthrough went through every step.
- So a walkthrough that fails is not spoken (and, with a cloud voice, paid for) first.
- The CLI gets the app's minimal environment plus `PLAYWRIGHT_BROWSERS_PATH`, `NARRATE_HOME`, `NARRATE_GEMINI_API_KEY` and `NARRATE_ELEVENLABS_API_KEY`.
- Voice and keys otherwise come from narrate's own settings (`~/.narrate/settings.json`, set up with `/narrate-setup`).
- The default voice is the OS voice.
- A key in a custom `apiKeyEnv` variable is not passed.
- It runs in `round-N/capture/narrate/`: the scene, narrate's own `narrate.log`, and its progress output in `cli-output.log`.
- The engine reads the video from narrate's `--json` result, which also refuses a video without a voice.
- It is stopped with its whole process tree after 10 minutes, on a cancel or when the factory exits.
- It never fails the run.
- The PR links the narrated video instead of the silent one, and only that one is uploaded.
- Without the plugin the silent video is used and nothing is said about it.
- A narration that was tried and failed is noted in the PR and the report.

## Nothing here fails the run

- Capture carries on when the app does not start, Playwright or its browser is missing, a walkthrough step fails, the agent's plan is unusable or the upload fails.
- `round-N/capture-report.md` and the PR description say why (for example "Screenshots could not be taken: …") and the run goes on.
- The PR gets only the first line of a problem.
- The app's log and the full error stay in the report (`factory show <run> capture`).
- Local paths in the errors the PR shows are shortened first:
  - a path in the repository becomes relative to it;
  - the home folder (or any `C:\Users\<name>`, `/home/<name>`, `/Users/<name>`) becomes `~`.
- The report keeps the paths as they were.
- Only a usage limit or a cancel stops the run here.
- After a usage limit, the next `factory run` captures again.

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
- The PR description gets a `## Screenshots` section with a before/after table, the video and the new errors.

## When it can't be attached

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

[All docs](README.md)
