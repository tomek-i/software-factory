# Pipeline

What `factory run` does, stage by stage.
Back to the [README](../README.md#pipeline) for the diagram, the gates and the loops.

Related docs:
- [Agent permissions](agent-permissions.md): what each role may read and write.
- [Run artifacts](run-artifacts.md): the files each stage leaves in the run folder.
- [Runs](runs.md): starting, naming, cleaning up and escalating runs.
- [Media hosting](media.md): where screenshots and videos go.

## Triage

- An agent with no shell reads the issue and the code.
- It writes `triage.md`: `APPROVE`, `REJECT` or `NEEDS_INFO`, and `READINESS: READY | INCOMPLETE`.
- Rejections and questions are posted on the issue.
- The `triage` gate then decides whether to continue.
- An approved issue that is INCOMPLETE goes to refine.
- A READY one skips refine and goes to the spec critic.
- After the author answers, `factory run` triages the issue again.
- Run `factory sync` first so it sees an edited issue.

## Refine

- Runs only for an INCOMPLETE issue: a refine agent writes what the issue leaves open.
- It has no shell, a read-only repo, and writes only its own file.
- It writes acceptance criteria, scope, out of scope and open questions (with the assumption it made for each) in `spec-N/refine.md`.
- Its header is `STATUS: REFINED`.
- `BLOCKED` with a reason stops the run for you.
- The engine posts the spec on the issue as one comment marked `<!-- factory:refine -->`.
- The engine edits that comment in place on later rounds, so the issue shows the current spec rather than every version.

## Spec critic

- A critic agent checks the issue's claims and acceptance criteria against the actual code, and the refined spec when there is one.
- It has no shell, is read-only, and writes only its own file.
- It writes `spec-N/critic.md` with `VERDICT: ACCEPT | REVISE | REJECT`, a `## Summary`, and `## Problems`, `## Questions` and `## Notes`.
- **ACCEPT** passes the `critic` gate on to build.
  - The builder gets the refined spec and the critic's notes.
  - The reviewers, the verifier, the approver and the hard-rule deletion check judge the change against them too.
- **Untrusted author**: the run always waits for you at the `critic` gate before build, whatever the gate mode.
  - The spec reaches the builder marked as untrusted data.
- **REVISE** goes back to refine with the critic's problems, up to `loops.max_critic_rounds` (default 2) critic rounds.
  - At the cap the run waits for you at the `critic` gate, with the open problems and the spec's open questions in the reason.
  - Approve the spec as it is, or send it back with `factory resume <run> --to refine -m "…"`.
  - Refine gets your comment.
- **REJECT** ends the run and posts the critic's problems on the issue.
- **Questions** only the issue's author can answer are posted on the issue, and the run waits in `needs_info`, as when triage asks.
  - The author's answers change the issue itself.
  - Once they have answered, `factory run` triages it again.
  - The spec then starts a new round, with a fresh `loops.max_critic_rounds` budget.
- **Gate modes**: like the approver, the critic only runs in `auto` mode (the default).
  - `gates.critic: always` goes straight to build without a critic turn.
  - A READY issue then goes from triage to build.
  - `human` waits for you without spending one.
- Each spec round has its own `spec-N/` folder.
- The number only grows, so a later round or a re-triage never overwrites an earlier round's files.

## Build

- A builder agent works in its own worktree and commits.
- The worktree is `.worktrees/<run>`, on branch `factory/<issue>-<slug>`, created from the latest `origin/<default branch>`.
- It cannot push.
- It runs the quick checks and the tests that cover its change, but not the whole test suite.
- The quality gate runs the whole suite once, on the commit the builder hands over.
- The engine scans every new commit for secrets (gitleaks if installed, otherwise built-in patterns).
- If the scan finds one, it sends the builder back, so a leaked key never reaches GitHub.
- Then the engine pushes the branch (never forced) and opens a **draft** PR that closes the issue.
- The PR title is the one the builder hands over: a Conventional Commit subject such as `feat(cli): add x`.
- So a squash merge leaves a conventional commit on the default branch.
- The PR description starts with a short brief for you (What, How it was tested).
- The builder's implementation notes are collapsed underneath.

## Quality gate

- The engine runs your `checks` on the pushed commit, plus the secret scan again.
- Checks run without `ANTHROPIC_API_KEY`, `GH_TOKEN` or `GITHUB_TOKEN` in their environment.
- On failure the builder gets the report and tries again, up to `loops.max_build_iterations`.
- Then the run waits for you.
- If two rounds in a row fail the same way, the run stops before the cap and waits for you.
- "The same way" means the same failed checks with the same output and exit code, and the same secret-scan hits.
- Timings, commit shas and the worktree path are ignored for that comparison.

## Reviews

- On a pass, reviewer agents look at the commit the gate passed, all at the same time, each through one lens.
- `reviews.always` (default code, security, docs) run every time.
- `reviews.ui` (default ux, ui) also run when triage listed `ui` in SURFACES.
- Each lens has its own model and effort (`models.reviews`).
- They read the change from `round-N/change.diff` and the code around it.
- Each writes `round-N/review-<lens>.md` with `VERDICT: PASS | CHANGES` and findings rated critical, major, minor or nit.
- Only critical and major findings count against a change.
- Minor ones and nits never hold the run up.
- If your usage limit is hit mid-review, `factory run` later only runs the lenses that have not written a review yet.

### Acceptance criteria

- The `acceptance` lens runs in every review round, whatever `reviews.always` and `reviews.ui` say.
- The engine, not the agent, reads the criteria.
  - They are the `- [ ]` / `- [x]` lines (or `*` bullets) under an "Acceptance criteria" heading (`##` to `####`).
  - It reads the issue body first, then the accepted refine spec (`spec-N/refine.md`).
  - It numbers them `AC-1`, `AC-2`, ... and hands that exact list to the agent, framed as data for untrusted authors.
- The agent (`review-acceptance.md` with `reviewer.md`) writes `round-N/acceptance.md`: `VERDICT: PASS | CHANGES` and a `## Criteria` JSON list.
  - Each id is `MET` (evidence: a test name or `file:line`), `NOT_MET` (what is missing) or `CANNOT_CHECK` (it needs an app, a browser or a person).
  - It can't add, reword or drop a criterion: unknown ids are ignored, and an id it leaves out counts as not checked.
- The engine records the result in `round-N/acceptance.json` and writes `round-N/review-acceptance.md` for the rest of the review.
  - Each `NOT_MET` becomes a major finding (`acceptance-AC-n`), so the verifier, the round cap and the stall check treat it like any other.
  - `CANNOT_CHECK` and not-checked criteria never block; they are listed for you.
- An issue without checkbox criteria skips the agent and passes with "no criteria".

## Verifier

- When a lens asks for changes, a verifier agent checks every critical and major finding against the code.
- It has no shell, and by default it uses a different model from the reviewers.
- It writes `round-N/verify.md`: `VERDICT: CONFIRMED` with the findings that hold.
- It adds a `## Refuted` line with the reason for each finding that doesn't hold.
- The engine rejects a verdict that skips a finding or judges one twice.
- **Confirmed** findings go back to the builder, which gets them in its next turn.
  - That costs a review round (`loops.max_review_rounds`).
  - The change goes through the quality gate and all reviews again.
- **Refuted** findings never loop.
- If the verifier refutes them all, the review counts as clear.
- If the verifier confirms the same findings two rounds in a row, or the cap is reached, the run waits for you at the `review` gate.
  - Approve it as is, or send it back with `factory resume <run> --to build -m "…"`.
  - The builder gets the confirmed findings and your comment.

## Review gate

- With clear reviews and the default `gates.review: auto`, the run goes on.
- It waits for you when a hard rule is hit or the gate is `human`.
- Approving it moves the run on.
- The reason has each lens's verdict.
  - For example `reviews: code CHANGES (1 blocking), security PASS, docs PASS; the verifier refuted all 1 blocking findings`.
  - With acceptance criteria it adds `acceptance PASS (8/8 met, 1 for you to check)`.
- The draft PR's description gets an **Acceptance criteria** checklist: each criterion with its status and evidence, and the count.
  - It is rebuilt every round, never stacked.
- The draft PR's description gets a **Review notes** section, for you to judge:
  - the minor findings and nits per lens;
  - the refuted findings, with the verifier's reason;
  - any confirmed findings still open when the run stopped at a stall or the cap.
- `factory show <run>` lists each review's summary and blocking findings, and the verifier's confirmed findings.
- `factory show <run>` and the web Run details list each acceptance criterion with its status and evidence.

### Hard rules

- Hard-rule hits are listed in the reason.
  - For example `protected path (infra/**): infra/main.tf` or `new dependency in package.json: left-pad`.
- They are read from the git diff of the checked commit against where the branch left the default branch.
- That point is fetched fresh from GitHub, so a builder cannot move the base.
- The hard rules are:
  - changes under protected paths;
  - new dependencies, or a dependency pointed at a new source (git, URL, `npm:` alias, override, Go `replace`);
    - in package.json, .csproj/Directory.Packages.props, requirements*.txt, pyproject.toml, Pipfile or go.mod;
  - any lockfile change;
  - changes to package-source config such as `.npmrc`, `pnpm-workspace.yaml`, `NuGet.Config`, `Directory.Build.props` or `.gitmodules`;
  - `.env*`, key, certificate and `.tfvars` files;
  - deleted files the issue and triage don't name by their path (a rename counts as a deletion).
- A run started with `--unsafe` still lists them, marked as lifted.
- The PR description of an `--unsafe` run opens with a warning.
- Protected paths in `hard_rules.paths` are repo-relative globs using only `*`, `**` and `?`.
- Anything else in `hard_rules.paths` is rejected when the config loads.

## Capture and PR

- Capture runs for a user-visible change (triage listed `ui` in SURFACES) of an app with `app.start` configured.
- Then the engine shows the change in the PR.
- Otherwise capture passes straight on, with an info line saying why.
- The `pr` gate (default `always`) then takes the draft PR out of draft.

### The plan

- A capture agent (no shell, writes only `round-N/capture.md`) reads the issue, the triage scope and `round-N/change.diff`.
- It writes a plan:
  - the pages to shoot (at most 10), each marked `new` (the change adds it) or `existing` (it changes);
  - an optional walkthrough drawn from the acceptance criteria.

### The walkthrough

- It is a fixed list of declarative steps: `goto` a path, `click` a selector or text, `fill` a selector, `wait`, `screenshot`.
- The engine validates and runs it.
- Nothing an agent writes is ever run as code.
- Every path must be on the app's own origin, and the browser never leaves it.
- Requests to other origins are blocked.
- A redirect to another origin is stopped before it is followed.
- A page or step that still ends up elsewhere is not shot.
- If the walkthrough leaves the app, it stops there and its video is discarded, as it may show a page outside the app.

### Clean worktree only

- Capture only starts the app on a clean worktree.
- If the worktree has uncommitted changes (for example your own edits in a run you resumed), the stage says so.
- It then goes on without screenshots, leaving the changes alone.

### Starting the app

- The engine starts `app.start` in the run's worktree on a free port (from the run's port block), passed in `app.port_env`.
- The app gets a minimal environment, not yours:
  - only what a shell, Node and package managers need (`PATH`, `SystemRoot`, `HOME`/`USERPROFILE`, `TEMP`, `APPDATA`, `LANG`, `NODE_ENV` and the like);
  - the port;
  - `BROWSER=none`;
  - the variables named in `app.env`.
- Tokens (`ANTHROPIC_API_KEY`, `GH_TOKEN`, `GITHUB_TOKEN`) are refused even there.
- Its pages are published, so nothing they render should come from your environment.
- The engine waits up to `app.ready_timeout_sec` for `app.url` to answer.
- The factory does not install dependencies for the app.
- Put the install step in `app.start` if it needs one (e.g. `npm ci && npm run dev`), since the before worktree is a fresh checkout.

### Shooting

- Playwright shoots every page at 1440 and 390 px wide.
- It records console errors, page errors, failed requests and 4xx/5xx responses.
- Then it records the walkthrough as `walkthrough.webm` (WebM, since MP4 would need ffmpeg).

### Before shots

- For `existing` pages it does the same in a temporary worktree of the freshly fetched `origin/<default branch>`.
- That worktree is removed again afterwards.
- `new` pages get no before shots, and the report says so.
- Errors only the change's version has are reported as new.

### Cleaning up

- Each server's whole process tree is killed when it is done with.
- That also happens on errors, timeouts, cancels and when the factory exits.
- Anything the app writes into the run's worktree that git does not ignore is undone, so the branch stays clean.

### Narrated walkthrough

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

### Where the media goes

- Screenshots and videos are attached to the run's PR, or go to a draft release when that fails.
- The details are in [Media hosting](media.md).
- They live in the run folder (`round-N/capture/`) and on GitHub.
- The PR description gets a `## Screenshots` section with a before/after table, the video and the new errors, above the review notes.

### Nothing here fails the run

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

## Re-sync and merge gate

- The engine merges the latest `origin/<default branch>` into the branch.
- A conflict is undone and goes back to the builder with the conflicting files (`round-N/resync/conflicts.md`).
- If the merge brought anything in, the quality gate runs again on the merge commit (`round-N/resync/checks.md`).
- A failure goes back to the builder with the report.
- Both a conflict and a failed re-check cost a review round.
- Then the `merge` gate decides.
- The default is `human`: it always waits for you.
- `factory approve` approves the commit that was waiting.
- The approval holds while only re-syncs of the default branch land on top of it.
- Any new commit from the builder needs a fresh approval.
- In `auto` mode an approver agent reads the run's reports and the final diff (`approval.diff`) and writes `approval.md`.
- `approval.md` says `DECISION: PROCEED`, or `ESCALATE` with its reasons.
  - Reasons are product decisions it had to assume, risky surfaces, a review outcome it doubts, scope, or low confidence.
- Hard-rule hits need you at the merge gate too, whatever its mode.
- When the merge gate waits for you, its reason lists the acceptance criteria for you to check (`CANNOT_CHECK` or not checked).

## Merge

- The engine merges the PR with `merge.method`:
  - `merge` (default) makes a merge commit;
  - `squash` titles the commit after the PR;
  - `rebase` rebases.
- It always merges with `--match-head-commit <sha>`, so GitHub only merges the commit that passed the gate.
- If branch protection requires status checks, it first waits for them (`gh pr checks --required`), looking every 30 seconds.
- A failed check, or one still running after `merge.checks_timeout_min` (default 30), stops for you with the check's name and link.
- Right after it pushed a re-synced commit, it looks for up to a minute before deciding no checks are required.
- That is because GitHub reports a new commit's checks only once CI picks it up.
- `factory run` prints that it is waiting and for which checks.
- `factory status` shows the run in `merge`.
- A commit pushed to the PR while it waits is never merged: `--match-head-commit` makes GitHub refuse.
- If GitHub refuses anyway (other branch protection rules), the run waits for you with GitHub's message.
- How this repo protects its own `main`: [docs/repo-settings.md](repo-settings.md).
- The run's worktree and branches are removed once the run is done (see [Cleaning up finished runs](runs.md#cleaning-up-finished-runs)).

### Ticking the acceptance criteria

- Only once the PR is merged, the engine ticks the `MET` criteria of the last review round on GitHub: `[ ]` becomes `[x]`.
  - That is after the factory merges it, or when it finds the PR merged on GitHub (the merge stage or `reconcile`).
  - Nothing is ticked before the merge, or when the PR is closed without merging.
- It changes only those checkboxes, on exactly the lines it read; no other text changes.
- The issue's own criteria are ticked in the issue body, only when the factory's account wrote the issue.
- The refine spec's criteria are ticked in the factory's refine comment.
- `CANNOT_CHECK`, not-checked and `NOT_MET` criteria stay unticked.
- A line that was edited since is left alone and noted; a GitHub failure is a warning and never reopens the run.

## Learn

- After the merge, a learner agent (no shell, writes only `learn.md`) looks back at the run.
- It reads:
  - the builder's report;
  - the checks of failed rounds;
  - the reviews and the verifier's judgements;
  - re-sync conflicts;
  - the approver's decision;
  - escalation reasons;
  - your decisions and comments.
- It writes `learn.md` with `LESSONS: <n>`.
- For each lesson it writes an observation, the evidence (files and rounds) and a one-line rule for `.factory/lessons.md`.
- It is told to propose only rules that would plausibly have prevented a real failure or loop in that run.
- So zero lessons is a normal outcome.
- The proposals are stored as `proposed`.
- Nothing is applied until you approve them (see [Lessons](lessons.md)).
- **Skipped when there is nothing to teach**, to save usage. That is a run that went through:
  - in one round;
  - with no failed check;
  - with no blocking finding;
  - with no hard-rule stop;
  - with no escalation by the approver;
  - with nobody stepping in other than to approve a gate.
- **It never holds a run up.** The merge has already happened.
- If the learner fails, writes something malformed twice, hits your usage limit, or anything else goes wrong while learning (even storing the lessons), the run is still `done`.
- Its lessons are then skipped, and the reason (`lessons skipped: …`) is in the run's events.
- A run that ends any other way does not go through the learner.
  - That is a run rejected, cancelled, or merged by hand on GitHub and picked up by `factory status`/`sync`.
