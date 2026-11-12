# Software Factory

An AI software factory that turns GitHub issues (or a free-text idea) into reviewed, tested, demo'd pull requests, driven by headless Claude Code on your own Claude subscription.

It runs in two modes on one engine:

- **CLI mode**: install into a single repo and drive it from the terminal.
- **Web mode** *(planned)*: a local dashboard that manages several repos, syncs GitHub issues both ways and runs issues in parallel.

> Status: early development. `factory new` drafts issues from an idea. A queued issue can run through triage, build, the quality gate loop, parallel reviews, the verifier's review loop, re-sync with the default branch and the merge gate to a merged PR (`factory run`), after which a learner proposes lessons for you to approve (`factory lessons`). Refine, spec critic and capture (screenshots) are not automated yet. By default the run waits for you at the `merge` gate.

## Pipeline

```
issue writer → triage → (refine) → spec critic → build → quality gate ⟲ → parallel reviews ⟲
            → capture (screenshots + walkthrough) → PR → merge decision → learn
```

- **Gates** after issue writer, triage, critic, plan, review, PR and merge each have a mode: `always` (pass through), `auto` (the agent decides or escalates with reasons) or `human` (always stop for you).
- **Loops** (failed checks, confirmed review findings) always go back to the builder, up to a cap, then escalate to you. A loop that fails the same way twice in a row escalates early, so a stuck builder does not use up the cap.
- **Hard rules** (protected paths, new dependencies, secret/env changes) always escalate to you, whatever the gate mode. Only a per-run `--unsafe` flag lifts them, and it can never be set in config.
- **State changes need evidence**: for example, reviews only start when the commit that passed the quality gate is the branch's current HEAD.

## Requirements

- Node.js 22+ and pnpm
- Git
- GitHub CLI (`gh`), logged in
- Claude Code (`claude`), logged in with your subscription. The factory removes `ANTHROPIC_API_KEY` from the agents' environment so runs use your subscription, not API billing.

## Usage

```sh
pnpm install
pnpm build

# in the repo you want to use the factory on
node <path-to-this-repo>/apps/cli/dist/main.js init
```

`factory init`:

- detects your stack (Node, .NET, Python, Go) and writes `.factory/config.yaml` with check commands. Review and commit it.
- writes `.factory/lessons.md`, which agents read before every run.
- adds runtime state (`.factory/runs/`, `.factory/factory.db*`, `.worktrees/`, `.factory/drafts/`) to `.gitignore`.
- registers the project in `.factory/factory.db`.
- creates GitHub status labels only if you enabled `github.status_labels` (off by default; see below).

It is safe to re-run. An existing config is never overwritten.

### Writing issues from an idea

```sh
factory new "export orders as CSV"   # draft an issue from an idea
factory new --list                   # drafts waiting for you
factory new --approve <draft>        # create a draft on GitHub, sync it and queue it
factory new --discard <draft>        # drop a draft
```

`factory new` runs an issue writer agent on your idea. It has no shell: it reads the repo and writes only its draft, `.factory/drafts/<draft>/draft.md` (`factory new` adds `.factory/drafts/` to `.gitignore` if it is missing). The draft is an issue with a title, `## Why`, `## What`, `## Acceptance criteria` (checkboxes), `## Scope` and `## Out of scope`, a UI flag and a risk rating. An idea too big for one PR becomes a parent issue plus two or more sub-issues (at most 10), each with the same structure; a sub-issue that needs another first says so with `DEPENDS_ON`, which ends up as `Depends on: #n` in its body. The draft is checked strictly; a malformed one gets one retry, then it is kept for you to fix or discard.

The `issue_writer` gate then decides:

- `human` (default): the draft is printed and saved, and the command exits. Edit `draft.md` if you like, then `factory new --approve <draft>` creates it; the file is read and checked again first.
- `auto`: the agent's own `DECISION: PROCEED` creates it straight away; `ESCALATE` waits for you as above, with its reasons.
- `always`: created straight away.

With `auto` or `always`, the agent's draft becomes a trusted issue (see [Trusted authors](#trusted-authors)) without anyone reading it first, so later stages treat it as the spec. The issue writer cannot read run folders (`.factory/runs/`), worktrees or other drafts, so text from untrusted issues does not reach it that way, but it does read the repo. Keep the default `human` unless you trust what is in your repo.

Creating opens the issues on GitHub (no labels), links each sub-issue to the parent as a real GitHub sub-issue, syncs them into `.factory/factory.db` and queues the buildable ones: the single issue, or the sub-issues (never their parent). It prints the numbers and the `factory run` command to start them. Creating always prints the full draft first. What has been created is recorded in `.factory/factory.db`, so if GitHub fails halfway, `factory new --approve` again only does what is left; an issue whose draft entry you edited after it was created is refused rather than matched up by position. If `gh issue create` succeeds but its output can't be read, the error names the title: check GitHub before approving again, as that issue may exist already. A draft with files that git tracks is refused: `factory new` only writes ignored files, so such a draft came from a commit, possibly someone else's branch. `<draft>` is a draft id or a unique prefix of one.

### Choosing what the factory works on

Work is picked **locally**, never from GitHub labels, so nobody on GitHub can feed issues into your factory.

```sh
factory sync               # pull open issues from GitHub into .factory/factory.db; finishes runs whose PR was merged or closed
factory issues             # list them (Q marks queued issues); --queued, --all
factory queue 12 15 18     # queue issues for the factory (fetches unsynced ones)
factory unqueue 15         # take one back out
```

Issues closed on GitHub drop out of the queue on the next sync.

### Running an issue

```sh
factory run 12             # run issue #12 until it needs you (syncs and queues it first if needed); --unsafe lifts hard rules for this run only
factory run 12 15          # run several issues at once, up to concurrency.max_runs; each line is prefixed [#12], [#15]
factory status             # active runs: state, round, cost, waiting gate; --all includes finished ones (finishes merged runs first); notes lessons waiting for you
factory logs 12            # events and agent log excerpts; -f follows a running run
factory show 12            # overview: state, gate, branch, PR, verdict summaries, files in the run folder
factory show 12 triage     # one file in full: triage, build, checks (latest round) or a path like round-2/checks.md
factory approve <run>      # let a run waiting at a gate continue and keep running it; -m "why", --no-run to only record it
factory reject <run> -m "why"   # end a run waiting at a gate
factory resume <run> --to build -m "why"   # send an escalated run back to a stage and keep running it; --reset-loops, --no-run
factory cancel <run>       # stop the run, its agent and running checks; the worktree is kept
factory lessons            # lessons the learner proposed, waiting for you; --all includes approved and rejected ones
factory lessons approve 3 4        # open one PR that appends these lessons to .factory/lessons.md
factory lessons reject 5 -m "why"  # never apply this lesson; -m is optional
```

`factory run <n>` is enough for a brand-new issue: running it is your decision to work on it, so if the issue isn't queued yet it fetches it fresh from GitHub and queues it, the same as `factory queue <n>`. Closed issues are refused, and an issue by an author outside `trust.authors` still waits for you at triage. Give several numbers to run them side by side in one terminal: at most `concurrency.max_runs` (default 2) run at once and the rest wait their turn. An issue that can't start (closed, not on GitHub) is skipped, the others still run, and the command exits non-zero. Once your usage limit is hit, issues not started yet are left for later. Ctrl+C stops all of them. `factory approve` and `factory resume` carry on driving the run in the same terminal, as `factory run` would; with `--no-run` they only record the decision.

`<run>` is a run id, a unique prefix of one, or an issue number (`12`) for that issue's latest run. `#12` works too, but PowerShell reads `#` as the start of a comment, so quote it there (`'#12'`).

What `factory run` does today:

1. **Triage**: an agent with no shell reads the issue and the code and writes `triage.md` (`APPROVE`, `REJECT` or `NEEDS_INFO`). Rejections and questions are posted on the issue. The `triage` gate then decides whether to continue. After the author answers, `factory run` again triages the issue again (run `factory sync` first so it sees an edited issue).
2. **Build**: a builder agent works in its own worktree (`.worktrees/<run>`, branch `factory/<issue>-<slug>`, created from the latest `origin/<default branch>`) and commits. It cannot push. The engine scans every new commit for secrets (gitleaks if installed, otherwise built-in patterns) and sends the builder back if it finds one, so a leaked key never reaches GitHub. Then the engine pushes the branch (never forced) and opens a **draft** PR that closes the issue. Its description starts with a short brief for you (What, How it was tested), with the builder's implementation notes collapsed underneath.
3. **Quality gate**: the engine runs your `checks` on the pushed commit, plus the secret scan again. Checks run without `ANTHROPIC_API_KEY`, `GH_TOKEN` or `GITHUB_TOKEN` in their environment. On failure the builder gets the report and tries again, up to `loops.max_build_iterations`, then the run waits for you. If two rounds in a row fail the same way (same failed checks with the same output and exit code, and the same secret-scan hits, ignoring timings, commit shas and the worktree path), the run stops before the cap and waits for you.
4. **Reviews**: on a pass, reviewer agents look at the commit the gate passed, all at the same time, each through one lens: `reviews.always` (default code, security, docs) every time, plus `reviews.ui` (default ux, ui) when triage listed `ui` in SURFACES. Each lens has its own model and effort (`models.reviews`). They read the change from `round-N/change.diff` and the code around it, and write `round-N/review-<lens>.md` with `VERDICT: PASS | CHANGES` and findings rated critical, major, minor or nit. Only critical and major findings count against a change; minor ones and nits never hold the run up. If your usage limit is hit mid-review, `factory run` later only runs the lenses that have not written a review yet.
5. **Verifier**: when a lens asks for changes, a verifier agent (no shell, by default a different model from the reviewers) checks every critical and major finding against the code and writes `round-N/verify.md`: `VERDICT: CONFIRMED` with the findings that hold, and a `## Refuted` line with the reason for each one that doesn't. The engine rejects a verdict that skips a finding or judges one twice. Confirmed findings go back to the builder, which gets them in its next turn; that costs a review round (`loops.max_review_rounds`), and the change goes through the quality gate and all reviews again. Refuted findings never loop: if the verifier refutes them all, the review counts as clear. If the verifier confirms the same findings two rounds in a row, or the cap is reached, the run waits for you at the `review` gate: approve it as is, or send it back with `factory resume <run> --to build -m "…"` (the builder gets the confirmed findings and your comment).
6. **Review gate**: with clear reviews and the default `gates.review: auto`, the run goes on. It waits for you when a hard rule is hit or the gate is `human`, with each lens's verdict in the reason, e.g. `reviews: code CHANGES (1 blocking), security PASS, docs PASS; the verifier refuted all 1 blocking findings`; approving it moves the run on. The draft PR's description gets a **Review notes** section listing the minor findings and nits per lens and the refuted findings with the verifier's reason, for you to judge, plus any confirmed findings still open when the run stopped at a stall or the cap. `factory show <run>` lists each review's summary and blocking findings, and the verifier's confirmed findings. If the branch trips a hard rule, the reason lists each hit, for example `protected path (infra/**): infra/main.tf` or `new dependency in package.json: left-pad`. They are read from the git diff of the checked commit against where the branch left the default branch, fetched fresh from GitHub (so a builder cannot move the base): changes under protected paths; new dependencies or a dependency pointed at a new source (git, URL, `npm:` alias, override, Go `replace`) in package.json, .csproj/Directory.Packages.props, requirements*.txt, pyproject.toml, Pipfile or go.mod; any lockfile change; changes to package-source config such as `.npmrc`, `pnpm-workspace.yaml`, `NuGet.Config`, `Directory.Build.props` or `.gitmodules`; `.env*`, key, certificate and `.tfvars` files; and deleted files the issue and triage don't name by their path (a rename counts as a deletion). A run started with `--unsafe` still lists them, marked as lifted, and its PR description opens with a warning. Protected paths in `hard_rules.paths` are repo-relative globs using only `*`, `**` and `?`; anything else is rejected when the config loads.
7. **Capture and PR**: capture (screenshots and a walkthrough) is not automated yet and passes straight on. The `pr` gate (default `always`) then takes the draft PR out of draft.
8. **Re-sync and merge gate**: the engine merges the latest `origin/<default branch>` into the branch. A conflict is undone and goes back to the builder with the conflicting files (`round-N/resync/conflicts.md`); that costs a review round. If the merge brought anything in, the quality gate runs again on the merge commit (`round-N/resync/checks.md`), and a failure goes back to the builder with the report. Then the `merge` gate decides (default `human`: it always waits for you). `factory approve` approves the commit that was waiting: the approval holds while only re-syncs of the default branch land on top of it, and any new commit from the builder needs a fresh one. In `auto` mode an approver agent reads the run's reports and the final diff (`approval.diff`) and writes `approval.md`: `DECISION: PROCEED`, or `ESCALATE` with its reasons (product decisions it had to assume, risky surfaces, a review outcome it doubts, scope, low confidence). Hard-rule hits need you at the merge gate too, whatever its mode.
9. **Merge**: the engine merges the PR with a merge commit (`gh pr merge --merge --match-head-commit <sha>`), so GitHub only merges the commit that passed the gate. If GitHub refuses (branch protection, required checks still running), the run waits for you with GitHub's message. Its worktree and branch are kept.
10. **Learn**: after the merge, a learner agent (no shell, writes only `learn.md`) looks back at the run: the builder's report, the checks of failed rounds, the reviews and the verifier's judgements, re-sync conflicts, the approver's decision, escalation reasons and your decisions and comments. It writes `learn.md` with `LESSONS: <n>` and, for each lesson, an observation, the evidence (files and rounds) and a one-line rule for `.factory/lessons.md`. It is told to propose only rules that would plausibly have prevented a real failure or loop in that run, so zero lessons is a normal outcome. The proposals are stored as `proposed` and nothing is applied until you approve them (see [Lessons](#lessons)). A run that went through in one round, with no failed check, no blocking finding, no hard-rule stop, no escalation by the approver and nobody stepping in other than to approve a gate, has nothing to teach, so the learner is not started for it (saving usage). The merge has already happened, so the learner never holds a run up: if it fails, writes something malformed twice, hits your usage limit, or anything else goes wrong while learning (even storing the lessons), the run is still `done`, its lessons are skipped, and the reason (`lessons skipped: …`) is in the run's events. A run that ends any other way (rejected, cancelled, or merged by hand on GitHub and picked up by `factory status`/`sync`) does not go through the learner.

You can also merge or close the PR yourself on GitHub at any point. The next `factory status`, `factory run` or `factory sync` sees it and marks the run `done`, with a `merge` decision holding the merge commit, or `cancelled` when the PR was closed without merging. You don't need `factory cancel`. Runs without a PR, or with an open one, are left alone, and if GitHub can't be reached the command prints a warning and carries on.

When a run escalates (agent failed, builder blocked, loop cap reached, loop stalled), `factory run` tells you why; a stall names both rounds, for example `stalled: quality gate failed the same way in rounds 2 and 3 (see round-2/checks.md and round-3/checks.md)`. A round is one pass through the quality gate (and the reviews after it); round numbers keep counting after a resume, so earlier rounds' files are never overwritten. Send it on with `factory resume` or stop it with `factory cancel`. After a resume, stall detection starts afresh (with or without `--reset-loops`): only two more identical failures in a row stop the run again. If your Claude usage limit is hit, the run stops where it is; run `factory run` again after the reset and it continues the same agent session. A malformed agent hand-over gets one retry with the problems listed, then the run waits for you.

Run artifacts (issue, triage, build report, `round-N/checks.md` and `checks.log`, `round-N/change.diff`, `round-N/review-<lens>.md`, `round-N/verify.md`, `round-N/resync/`, `approval.md` and `approval.diff`, `learn.md`, agent prompts, permission profiles and full stream logs) are in `.factory/runs/<run>/`. `factory show <run>` summarises them and `factory show <run> <file>` prints one; when a run waits at a gate, `factory run` names the file to read, for example `factory show <run> build` at the `review` gate.

**What steers the agents is read from the default branch.** `factory run` reads `.factory/config.yaml`, `.factory/prompts/<role>.md` and `.factory/lessons.md` from `origin/<default branch>`, not from your working copy, so a checked-out branch cannot change its own checks, trust list, gates or prompts. Commit and push config changes before they take effect.

**Agent permissions.** Agents run with `--permission-mode dontAsk` and a per-role allowlist (in `.factory/runs/<run>/agent/`), and ignore your own Claude Code settings, hooks and MCP servers (`--setting-sources ""`, `--strict-mcp-config`) so nothing outside the profile applies to an agent reading issue text. Triage can read the repo and write only its run folder. Reviewers have no shell: the engine writes the commits and the full diff to `round-N/change.diff` for them (with external diff programs and textconv switched off), and each reviewer can write only its own review file, so one lens cannot change another's verdict; their prompt is `.factory/prompts/reviewer.md` plus `review-<lens>.md`. The verifier gets the same: no shell, the same change file, and only `verify.md` to write (prompt `.factory/prompts/verifier.md`). So does the approver, with only `approval.md` to write (prompt `.factory/prompts/approver.md`), and the issue writer, with only its `draft.md` to write and no access to `.factory/runs/`, `.worktrees/` or other drafts (prompt `.factory/prompts/issue_writer.md`), and the learner, with only `learn.md` to write (prompt `.factory/prompts/learner.md`). The builder can edit and use Bash but is denied `git push`, `gh pr`, `gh api` and edits to `.factory/`. Bash deny rules are prefix matches, so also protect your default branch on GitHub.

### Lessons

`.factory/lessons.md` is put in front of every agent's task as "Lessons from earlier runs". After a run with something to learn from, the learner proposes lessons, and `factory status` says when some are waiting (`3 lessons waiting: factory lessons`). `factory lessons` lists each one with its id, the run it came from, the rule, what went wrong and the evidence.

- `factory lessons approve <id...>` opens **one PR** for all the lessons you name: the engine (not an agent) creates `factory/lessons-<timestamp>` from the freshly fetched `origin/<default branch>` in a temporary worktree (removed afterwards, your working copy is not touched), appends each rule as a `- ` line to `.factory/lessons.md`, commits, pushes and opens a ready-for-review PR listing each lesson and its run. While a lessons PR is still open, later approvals go onto its branch and update its description instead, because two PRs that both append to the end of the file would conflict. The lessons are marked approved, with the PR number, only once they are on the PR; if a PR cannot be opened, the pushed branch is deleted and nothing is approved. Because agents read lessons from the default branch, an approved lesson takes effect when you merge that PR.
- The lessons commit runs your repository's own commit hooks and signing; they are never skipped. A hook that needs something a fresh worktree lacks (husky without `node_modules`, say), or signing that cannot run without a prompt, refuses the commit: `factory lessons approve` then says a commit hook or signing refused it, and the lessons stay proposed. Each git command there is stopped after 5 minutes.
- A rule must be one line of at most 300 characters without control or text-direction characters, and `factory lessons` shows any such character in a lesson as `[U+XXXX]` rather than printing it.
- `factory lessons reject <id...> -m "why"` marks them rejected; they are kept with your reason and never applied.

### Trusted authors

Anyone who can open an issue can write text the agents will read, so the factory distinguishes trusted authors:

```yaml
trust:
  authors: ["your-handle", "teammate"]   # init pre-fills your own gh login
  everyone: false                        # true for private repos where only approved people open issues
```

- **Trusted** issues and comments are treated as the spec.
- **Untrusted** ones (e.g. strangers on a public repo) can still be queued, but their text is handled as untrusted data and triage always waits for your approval before anything is built. `factory issues` marks them `(untrusted)`.
- **Issues the factory created** with `factory new` are trusted, whoever the gh login is: they were written from your own idea and approved by you (or by the gate you configured). The factory records this locally when it creates them, so a later `factory sync` never clears it and nobody on GitHub can set it. Comments on them by others are still judged by their own author.

**Status labels (optional).** With `github.status_labels: true`, the factory mirrors run status onto the issue (`factory`, `factory:in-progress`, `factory:needs-info`, `factory:needs-human`, `factory:unsafe`). They are display-only and never read as input. Run `factory init` again after enabling them to create the labels.

## Configuration

See the comments in the generated `.factory/config.yaml`. The main sections:

| Key | Purpose |
|---|---|
| `checks` | Commands that must all pass before reviews start |
| `app` | How to start the app for screenshots and videos |
| `gates` | `always` / `auto` / `human` per gate |
| `hard_rules` | Paths and triggers that always escalate to a human |
| `loops` | Caps for build iterations, review rounds and spec critic rounds |
| `reviews` | Which review lenses run always and which only for UI changes |
| `models` | Model and effort per agent role and review lens, with overrides when triage rates the risk HIGH |
| `trust` | Whose issues and comments count as the spec |
| `github` | Optional status labels, sync interval, daily start limit |

## Development

```sh
pnpm test        # vitest
pnpm typecheck   # tsc, including tests
pnpm lint        # eslint
pnpm build       # tsc -b
pnpm factory init   # run the CLI from source
```

Layout:

```
apps/cli          the `factory` command
packages/core     engine: config, SQLite store, state machine, gates, agent runner, prompts,
                  worktrees, quality gate, pipeline driver, init, GitHub issue sync, lessons PR
  prompts/        shipped role prompts (override per repo in .factory/prompts/<role>.md)
  test/           fake `claude` binary and fixtures: tests never spend real usage
packages/shared   zod schemas shared by everything (config, run states, agent verdicts)
```
