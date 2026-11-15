# CLAUDE.md

Orientation for Claude Code sessions working on this repo: where things live, what must stay true, and what reviews keep catching. The README has the long versions; follow the links.

Factory agents start with `--setting-sources ""` and do not load this file on their own.

## Architecture map

A pnpm monorepo in TypeScript (ESM). The short layout is in [README: Development](README.md#development).

`packages/shared/src`: zod schemas used everywhere
- `states.ts`: `STAGES`, parked and terminal states, `GATES` and gate modes
- `config.ts`: the `.factory/config.yaml` schema and defaults, `AGENT_ROLES` for per-role models
- `verdict.ts`: agent output headers (`verdictHeaderSchemas`), `parseVerdict`, findings, lessons
- `capture.ts`: the capture agent's plan (`capturePlanSchema`), data only, same-origin paths
- `registry.ts`: the per-user project list's file format (`registryFileSchema`)

`packages/core/src`: the engine, exported through `index.ts`
- `pipeline/transitions.ts`: `RunMachine`, the forward edges and the guards on them
- `pipeline/driver.ts`: `PipelineDriver`, whose private `step` has a `case` per stage; `approveTarget`, `prBody`
- `pipeline/gates.ts`: `resolveGate`, which turns gate mode, agent decision and hard rules into proceed or wait
- `pipeline/hard-rules.ts`: protected paths, dependency and lockfile rules that always escalate
- `pipeline/reconcile.ts`: finishes runs whose PR was merged or closed on GitHub
- `pipeline/cleanup.ts`: removes finished runs' worktrees and branches
- `pipeline/fingerprint.ts`: detects stalls (the same gate failure or findings twice)
- `agents/runner.ts`: spawns `claude` with `claudeArgs` and `agentEnv`
- `agents/prompts.ts`: `PromptRole`, `rolePrompt`, `permissionProfile`, `issueBlock`, `renderTask`
- `agents/turn.ts`: one agent turn plus parsing its output file; `agents/stream.ts`: stream-json summary
- `store/store.ts`: the SQLite store; `store/migrations.ts`: `MIGRATIONS`
- `github/port.ts`: `GithubPort` and its real `gh` implementation, `ghPort`
- `github/issues.ts`: issue sync; `github/media.ts`, `github/attachments.ts`: videos and images on PRs; `github/labels.ts`: status labels
- `capture/`: starts the app (`server.ts`), drives Chromium (`browser.ts`), renders narrated video (`narrate.ts`), writes the report (`report.ts`)
- `config/load.ts`: parses config; `config/trusted.ts`: `trustedReader`, `loadTrustedConfig`
- `gate/gate.ts`: the quality gate (`runQualityGate`); `gate/secrets.ts`: secret scan of the diff
- `git/worktrees.ts`: creates and removes run worktrees in the repo's `.worktrees` folder
- `lessons/publish.ts`: the lessons PR (`publishLessons`)
- `drafts/`: issue writer drafts for `factory new`
- `init/`: `factory init`, project detection and the config template
- `service/`: the run actions every front end shares (`driveIssue`, `approveRun`, `rejectRun`, `cancelRun`, `runOverview`, `reconcileAndSweep`, lessons and drafts). They return data and throw `ServiceError`
- `service/project.ts`: `openProject` for the repo containing a folder, `openRegisteredProject` for an entry in the project list
- `registry.ts`: the per-user project list (`registerProject`, `listRegistered`, `unregisterProject`), in `factoryDataDir` (`github/attachments.ts`); writes take a lock file
- `scheduler/`: `Scheduler` (`scheduler.ts`), which continues stopped runs and starts queued issues across projects within the limits, pausing on the usage limit; `stop.ts` for `factory stop`
- `util/`: `exec.ts` (`runCommand`), `process.ts` (`killTree`), `redact.ts` (`redactPaths`), `git.ts`

`packages/core/prompts/`: shipped role prompts. A repo overrides one with `.factory/prompts/<role>.md` on its default branch.

`packages/core/test/`: the fake `claude`, stream fixtures and the shared driver setup.

`apps/cli/src`: the `factory` command
- `main.ts` and `program.ts`: entry point and commander wiring
- `commands/`: one file per command group, such as `runs.ts`, `show.ts`, `issues.ts`, `lessons.ts`, `new.ts`, `projects.ts`, `work.ts`, `serve.ts`: formatting over `packages/core/src/service/`
- `context.ts`: `withProject` over the core `openProject`, turning a `ServiceError` into a `CliError`; `self.ts`: `refuseRunningOnItself` (see [Dogfooding](README.md#dogfooding))

`apps/server/src`: `factory serve` (see [Web mode](README.md#web-mode))
- `server.ts`: `createServer`, the Fastify routes over `packages/core/src/service/`, the Host, token and Origin checks, the event stream; `security.ts`: the token and those checks
- `projects.ts`: `ProjectSet`, one context per project shared by the routes and the scheduler; `hub.ts`: `EventHub`
- `serve.ts`: `startServe`, which reconciles, starts the `Scheduler` and listens on 127.0.0.1

`apps/web/src`: the web app (React, Vite, Tailwind), built into `apps/web/dist` and served by the server
- `lib/api.ts`: the client and the server's shapes; `lib/events.tsx`: the one event stream per page; `screens/`: Inbox, Runs, Backlog; `components/ui/`: shadcn-style parts

## Core invariants

- Every state change goes through `RunMachine` in `packages/core/src/pipeline/transitions.ts`: `transition` for automatic moves along guarded edges, `resume` for a human. Never write a run's state directly.
- Every gate decision goes through `resolveGate` in `packages/core/src/pipeline/gates.ts`. Hard rules (unless the run is `--unsafe`) and untrusted authors force a human whatever the mode.
- Config, prompts, checks, the trust list and lessons are read from `origin/<default>` through `packages/core/src/config/trusted.ts`, never from the working tree. A branch must not change the rules it is judged by.
- An agent writes exactly one output file, in the verdict format of `packages/shared/src/verdict.ts`: a header of `KEY: VALUE` lines, then markdown sections. The engine checks it; a missing or malformed file blocks the move.

## How to add things

A stage:
- Add it to `STAGES` in `packages/shared/src/states.ts`, in pipeline order.
- Add its edges to `FORWARD` and any guards to `GUARDS` in `packages/core/src/pipeline/transitions.ts`.
- Add a step method and a `case` in `PipelineDriver.step` (`packages/core/src/pipeline/driver.ts`).
- If it has a gate, add it to `GATES` and handle it in `approveTarget`.
- Summarise its output file in `runOverview` (`packages/core/src/service/show.ts`) and format it in `apps/cli/src/commands/show.ts`.
- Update the README [Pipeline](README.md#pipeline) diagram and text.

An agent role:
- Add it to `PromptRole` in `packages/core/src/agents/prompts.ts` and `AGENT_ROLES` in `packages/shared/src/config.ts`.
- Write `packages/core/prompts/<role>.md`.
- Give it a profile in `permissionProfile`: no shell, writing only its own output file, unless it truly needs more.
- Add its kind to `verdictHeaderSchemas` and its file to `verdictPath` (a private function in `packages/core/src/pipeline/driver.ts`).
- Add a row to the README's role table under [Running an issue](README.md#running-an-issue).

A migration:
- Append a new entry to `MIGRATIONS` in `packages/core/src/store/migrations.ts`. Never edit or reorder an applied one: the version is the entry's position.

A `GithubPort` method:
- Add it to the interface and to `ghPort` in `packages/core/src/github/port.ts`, with a test in `packages/core/src/github/port.test.ts`.
- Add it to every test fake: grep for `: GithubPort` (the shared ones are in `packages/core/test/driver-setup.ts` and `apps/cli/test/runs-setup.ts`).

## Security checklist

From the adversarial reviews of #58 to #61. The protections are summarised in [SECURITY.md](SECURITY.md).
- Issue text, comments and agent output derived from them are untrusted data. Frame them as data (`issueBlock`), and never let them become a trusted spec without a human. See [Trusted authors](README.md#trusted-authors).
- Never read trust, config or progress from files a branch can plant in the working tree. Use the trusted reader, the store or the run folder.
- Know what each child process's environment holds. Only the app started for capture gets an allowlist (`APP_ENV_ALLOWLIST` in `packages/core/src/capture/server.ts`). Checks get the full environment minus `CHECK_ENV_DENYLIST`, so no tokens. Agents get the full environment minus `AGENT_ENV_DENYLIST`, with `gh` logged out and git's credential helpers, askpass and ssh keys off (`agentEnv`); they still run as the user, so an agent can undo this on purpose (a barrier, not a sandbox). A new child process whose output is published gets an allowlist.
- Clean up processes, worktrees and temp dirs on every path: success, error, timeout, cancel and signal. Kill whole process trees with `killTree`.
- Anything posted to GitHub: quote `@mentions` (`quietMentions`), and keep logs and local paths out of PR bodies and comments (`redactPaths`).
- Commit hooks and signing are never skipped (no `--no-verify`, no `--no-gpg-sign`).

## Testing

- Vitest. Agents are the fake `claude` (`packages/core/test/fake-claude.mjs`, driven by `fakeClaude` in `packages/core/test/helpers.ts`), and GitHub is a fake `GithubPort` or a fake `CommandRunner`. Never spend real usage or call real GitHub.
- Shared setups: `packages/core/test/driver-setup.ts` for the driver, `apps/cli/test/runs-setup.ts` for the CLI run commands.
- Driver tests live next to the source as `packages/core/src/pipeline/driver.<area>.test.ts`. Put new ones in their own file so they run in parallel.
- Run the targeted tests while working (`pnpm vitest run <file>`) and the full suite once at the end, with `pnpm lint` and `pnpm typecheck`.
- Every test file gets its own temp `FACTORY_DATA_DIR` (`packages/core/test/setup-data-dir.ts`), so `factory init` in a test never adds to the user's project list.
- `FACTORY_REQUIRE_BROWSER=1` makes the real-browser tests fail rather than skip without Chromium; `FACTORY_TEST_NARRATE=1` runs the real narrate plugin tests. See [Development](README.md#development).
- `packages/core/test/claude-md.test.ts` checks that every path, symbol and link in this file exists.

## Windows notes

- The shell is Git Bash: POSIX syntax, forward slashes.
- Use Edit or Write rather than sed for multi-line edits.
- Preserve line endings: the repo is LF (`.gitattributes`).
- Kill process trees with `taskkill /pid <pid> /T /F`, as `killTree` does; killing only the child leaves its shells and servers running.

## Conventions

- Conventional Commits for commits and PR titles; PRs are squash-merged. See [CONTRIBUTING.md](CONTRIBUTING.md#pull-requests).
- No AI attribution or co-author trailers.
- Comments explain why, not what.
- Every change comes with tests; never weaken, skip or delete a test to make it pass.
- Update the README when behaviour, config or commands change.
