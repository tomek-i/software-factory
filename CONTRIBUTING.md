# Contributing

Thanks for helping! Start with the [README](README.md) to see what the factory does.

## Before you start

- **License:** the project is source-available under the [PolyForm Noncommercial License](LICENSE), not open source. Read what that allows in the README's [License](README.md#license) section.
- **CLA:** pull requests from others need a signed [Contributor License Agreement](CLA.md). A bot asks for it on your first pull request, and you sign by commenting.
- **Security problems** go to private reporting, never a public issue. See [SECURITY.md](SECURITY.md).

## Issues

- Use the bug or feature form.
- Write a feature request so someone can build it without asking you anything: **Why**, **What** (files, commands, config) and **Acceptance criteria**.
- The factory may pick up clear issues and implement them itself. The clearer the issue, the better the result.

## Setup

You need Node.js 22+, pnpm, Git and the GitHub CLI. Windows, macOS and Linux all work.

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

- Tests never spend real Claude usage: they use a fake `claude` and fake GitHub calls.
- Browser tests run only when Playwright's Chromium is installed (`pnpm exec playwright install chromium`).

## Pull requests

- Branch from `main` as `type/short-description`, e.g. `fix/merge-gate-retry`.
- The PR title is a [Conventional Commit](https://www.conventionalcommits.org/) subject: `type(scope): subject`, lowercase, imperative, no period. Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- Commit messages follow the same format.
- Every change comes with tests. Never weaken, skip or delete a test to make it pass.
- `pnpm lint`, `pnpm typecheck` and `pnpm test` must pass. CI runs them on Linux and Windows.
- Update the README when behaviour, config or commands change.
- Fill in the PR template: what, why, how it was tested.
