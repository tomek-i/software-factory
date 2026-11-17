# Contributing

Thanks for helping! Start with the [README](README.md) to see what the factory does.

- [Before you start](#before-you-start)
- [Issues](#issues)
- [Development](#development)
- [Run from source](#run-from-source)
- [Pull requests](#pull-requests)
- [Dogfooding](#dogfooding)
- [Releases](#releases)

## Before you start

- **License:** the project is source-available under the [PolyForm Noncommercial License](LICENSE), not open source. Read what that allows in the README's [License](README.md#license) section.
- **CLA:** pull requests from others need a signed [Contributor License Agreement](CLA.md). A bot asks for it on your first pull request, and you sign by commenting.
- **Security problems** go to private reporting, never a public issue. See [SECURITY.md](SECURITY.md).
- **[CLAUDE.md](CLAUDE.md)** has a file-by-file map, the invariants, checklists for adding a stage, an agent role, a migration or a GitHub call, and the security checklist.
  Read it before changing the engine, whether you are a person or a Claude Code session.

## Issues

- Use the bug or feature form.
- Write a feature request so someone can build it without asking you anything: **Why**, **What** (files, commands, config) and **Acceptance criteria**.
- The factory may pick up clear issues and implement them itself. The clearer the issue, the better the result.

## Development

You need Node.js 22.12+, pnpm, Git and the GitHub CLI. Windows, macOS and Linux all work.

```sh
pnpm install
pnpm test:unit          # the fast loop: unit tests only, in seconds
pnpm test               # every test, unit and integration (what CI and the quality gate run)
pnpm test:integration   # integration tests only: minutes
pnpm typecheck          # tsc, including tests
pnpm lint               # eslint
pnpm build              # tsc -b, the web app with Vite, then the npm package's bundle (apps/cli/dist)
pnpm factory status     # run the CLI from source, on this repo
```

Tests never spend real Claude usage: they use a fake `claude` and fake GitHub calls.

### Unit and integration tests

- They are two Vitest projects in `vitest.config.ts`, `unit` and `integration`, and the file name decides which.
- Integration tests are named `*.int.test.ts`: they start processes (real git repos, the fake `claude`, apps, Chromium) and take minutes.
- Every other `*.test.ts` file is a unit test and must start no process.
  The unit project fails a test that tries, with a message to rename the file.
- Integration tests get a long default timeout (`GIT_TEST_TIMEOUT`), because git and processes are slow on Windows and on a busy machine.

### The web app

- To work on it with hot reload, run `factory serve --no-open` from the built CLI, then `pnpm -C apps/web dev`.
- Vite proxies `/api` to the server (`FACTORY_SERVE_URL`, default `http://127.0.0.1:4180`).
- Open the printed link with Vite's port instead of 4180.
- The web tests run in jsdom with a fake server and event stream.

### Browser tests

- The capture tests that drive a real browser run only where Playwright's Chromium is installed (`pnpm exec playwright install chromium`).
- They are skipped otherwise.
- Set `FACTORY_REQUIRE_BROWSER=1` (for example in CI) to make a missing browser fail the tests instead.

### Narrate tests

- The tests that render with the real narrate plugin are skipped unless you set `FACTORY_TEST_NARRATE=1`.
- That is because they test the narrate version installed on your machine, not this repo.
- With the flag they need the plugin (in `~/.claude/plugins/cache`), ffmpeg on `PATH` and Playwright's Chromium, and fail if any of them is missing.
- They use narrate's silent mock voice, so they cost nothing:

  ```sh
  FACTORY_TEST_NARRATE=1 pnpm vitest run packages/core/src/capture/narrate.int.test.ts
  ```

- The quality gate runs `pnpm test` with your environment, so leave the flag unset in the shell that runs the factory.
  Otherwise an old narrate install can fail a run's `test` check.

### Layout

```
apps/cli          the `factory` command, published to npm as @tomek-i/software-factory
apps/server       `factory serve`'s local HTTP server: API over the run actions, event stream, session token
apps/web          the web app (React, Vite, Tailwind), served by apps/server
packages/core     engine: config, SQLite store, state machine, gates, agent runner, prompts,
                  worktrees, quality gate, capture (app, browser), pipeline driver, init, GitHub issue sync, lessons PR,
                  and the run actions the CLI formats (run, approve, reject, resume, cancel, show, lessons, drafts)
  src/pipeline/   the pipeline driver (driver.ts) and one module per stage in stages/ (triage, refine, critic,
                  build, gate, review, capture, pr, merge, learn)
  prompts/        shipped role prompts (override per repo in .factory/prompts/<role>.md)
  test/           fake `claude` binary and fixtures: tests never spend real usage
packages/shared   zod schemas shared by everything (config, run states, agent verdicts)
docs/             the user docs (start at docs/README.md)
```

## Run from source

To use your checkout as the global `factory`:

```sh
pnpm install
pnpm build
pnpm add -g "$(pwd)/apps/cli"
```

- This links the checkout instead of copying it, so a later `pnpm build` updates the global `factory`.
- But it can't run the factory on this repo's own issues: see [Dogfooding](#dogfooding).
- `pnpm -C <path-to-this-repo> factory` is not a substitute: pnpm runs the script in the factory's own folder.
  The CLI acts on its working directory, so it would always act on this repo.

## Pull requests

- Branch from `main` as `type/short-description`, e.g. `fix/merge-gate-retry`.
- The PR title is a [Conventional Commit](https://www.conventionalcommits.org/) subject: `type(scope): subject`, lowercase, imperative, no period. Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. A check fails the PR otherwise.
- PRs are squash-merged, so the PR title becomes the commit on `main`.
- `main` is protected: changes land only through a PR, CI and the title check must pass, and the branch must be up to date with `main`. See [docs/repo-settings.md](docs/repo-settings.md).
- Commit messages follow the same format.
- Every change comes with tests. Never weaken, skip or delete a test to make it pass.
- `pnpm lint`, `pnpm typecheck` and `pnpm test` must pass. CI runs them on Linux for pull requests, and on Linux and Windows after a merge to main. If your change touches processes, paths or git plumbing, also run them on Windows yourself.
- Update the README and `docs/` when behaviour, config or commands change.
- Fill in the PR template: what, why, how it was tested.

## Dogfooding

The factory works on its own issues.
It runs from the **published npm package**, never from the code its runs change.

- **Why:** a merged PR, or an agent reaching outside its worktree, would otherwise change the code that is running.
  - `factory run`, `approve`, `resume` and `new "<idea>"` refuse to start agents with a copy that lives inside the repository they would change.
  - Inside means its checkout or one of its `.worktrees/`.
  - A global `factory` linked from the checkout with `pnpm add -g "$(pwd)/apps/cli"` counts as inside.
  - Other commands, such as `pnpm factory status` or `approve --no-run`, still work from source.
- **Install** with `npm i -g @tomek-i/software-factory`. It replaces a global `factory` linked from a checkout.
- **Register this repo** with `factory init` in your checkout. The committed `.factory/config.yaml` is kept.
- **Run an issue** with `factory run <issue>` in your checkout.
  - In `.factory/config.yaml` every gate but `merge` is on `auto`: agents decide.
  - A run stops for you only on an escalation (a hard rule, an untrusted author, a loop cap) and at the merge gate.
  - The first run had every gate on `human`.
  - Note that on `human` the spec critic runs no agent; the gate only asks you to accept the spec triage already showed you.
- **Update** with `factory upgrade` after a release; it refuses while a run is in progress.
- **Unreleased `main`:** to run code that is merged but not released yet, build a clone outside every repository and link it instead (PowerShell):

  ```powershell
  $pinned = "$env:LOCALAPPDATA\software-factory\pinned"
  git clone https://github.com/tomek-i/software-factory $pinned
  pnpm -C $pinned install --frozen-lockfile; pnpm -C $pinned build
  pnpm add -g "$pinned\apps\cli"
  ```

  Update it only after a PR merged and no run is in progress:
  `git -C $pinned pull --ff-only; pnpm -C $pinned install --frozen-lockfile; pnpm -C $pinned build`.

## Releases

[release-please](https://github.com/googleapis/release-please) keeps a release PR open with the changelog built from the conventional commits on `main`.

- Merging that PR tags `v<version>` and publishes a GitHub release.
- It bumps the version in `package.json`, `apps/cli/package.json` and `factory --version`.
- It stages the CLI on npm as [`@tomek-i/software-factory`](https://www.npmjs.com/package/@tomek-i/software-factory).
- Only `feat`, `fix`, `perf`, `refactor`, `docs` and `revert` commits show in the changelog.
- CI does not run on the release PR: it is opened with the default `GITHUB_TOKEN`, and GitHub does not start workflows for that token's events.
- The release PR only changes `CHANGELOG.md`, `.release-please-manifest.json` and version strings.

### The npm package

- The npm package is `apps/cli`.
- `apps/cli/scripts/bundle.mjs` bundles the CLI and the workspace packages into `dist/main.js` with esbuild.
- It copies the shipped prompts and the built web app next to it.
- npm dependencies stay external, so every one the bundle imports must be listed in `apps/cli/package.json`.
- CI packs it on every push and checks the tarball (`apps/cli/scripts/check-pack.mjs`).
- The release workflow publishes with npm [trusted publishing](https://docs.npmjs.com/trusted-publishers), so no npm token is stored.
- npm only allows a trusted publisher on a package that exists, so the package was set up once by hand:

1. Merge the first release PR that includes the npm package. Its `npm` job fails, because the package does not exist yet.
2. Publish that release by hand from its tag, so the npm version matches the git tag:
   `git checkout v<version>`, `npm login`, `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm --filter @tomek-i/software-factory publish`.
3. On npmjs.com, add a trusted publisher in the package's settings: GitHub Actions, repository `tomek-i/software-factory`, workflow `release-please.yml`, no environment.
   Leave "Allow npm publish" and "Allow npm dist-tag" unticked.
   Set publishing access to require two-factor authentication without bypass tokens.

After that, each release **stages** its version on npm (`npm stage publish`) rather than publishing it.

- Nothing goes live without a maintainer's 2FA, even if the workflow or an action it uses is compromised.
- To make a release live, approve it on npmjs.com.
- Or run `npm stage list @tomek-i/software-factory` and then `npm stage approve <stage-id>`.
