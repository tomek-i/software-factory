# Security audits

`factory audit` scans the whole default branch for vulnerabilities with Anthropic's [claude-security](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/claude-security) Claude Code plugin.
The [deep security scan](pipeline.md#deep-security-scan) looks at one change; an audit looks at everything already merged.

Install the plugin first: `/plugin install claude-security@claude-plugins-official`.

## Commands

```sh
factory audit                          # scan the default branch now; minutes, longer on a big repository
factory audit list                     # this project's audits, newest first
factory audit show [audit]             # an audit's findings, the newest by default
factory audit file <finding>           # open a GitHub issue for one finding; --audit <id> for an older audit
factory audit file <finding> --public  # file it even though the repository is public
```

## On a schedule

- Set [`security.audit_schedule`](configuration.md#security) to `weekly` or `monthly` on the default branch (it is `off` by default).
- `factory work` and `factory serve` then audit the project when the newest audit is older than a week or a month.
  - A failed or skipped audit counts, so a missing plugin waits for the next interval rather than retrying.
  - A cancelled one doesn't, so an audit cut short by `factory stop` runs again.
- A worker looks whether an audit is due at most once an hour per project, since reading the schedule fetches the default branch.
- An audit takes one of the worker's slots (`--max-runs`), after the runs waiting for one.
  It doesn't count against the project's `concurrency.max_runs`, which limits runs on its worktrees.
- A worker runs one audit at a time, so audits never hold every slot for hours.
- An audit going on is recorded as running, so no other worker and no `factory audit` starts a second one of the same repository.
  One whose process died is read as cancelled.
- When git can't give an audit a checkout, the worker tries again after 30 minutes.
- `factory stop` and Ctrl+C stop an audit going on rather than waiting for it; the worker exits once its worktree is removed.
  The next audit starts from the beginning.
- The scan doesn't recognise a usage limit, so an audit that hits one is recorded as failed and the worker doesn't pause for it.
- The [Audits screen](web-mode.md#audits) shows them and can ask for one now.

## What an audit does

- It fetches the default branch and scans it as merged on GitHub, in a temporary worktree outside the repo.
  Your checkout and its uncommitted changes are never scanned or touched.
- The settings come from the default branch's `.factory/config.yaml`, like a run's: [`security.audit_effort`](configuration.md#security) and `security.audit_timeout_min`.
- The model is the scan's: `models.reviews.security-scan`, else Opus.
- The scan's agents run as for the [deep security scan](pipeline.md#deep-security-scan): your Claude Code login and user settings, no tokens, `gh` logged out, no sandbox.
- The plugin verifies each finding before it reports it.
  CRITICAL is critical, HIGH and MEDIUM are major, LOW is minor.
- Ctrl+C stops the scan and removes the worktree; the audit is recorded as cancelled, and `factory audit` exits with 130.
  An audit that couldn't scan exits with 1.
- `security.scan_tool: off` turns audits off too.

## Where the results go

- Each audit gets a folder in the factory's data folder, outside the repository: `audits/<owner-repo>/<started>/`.
  - On Windows that is `%LOCALAPPDATA%\software-factory`, elsewhere `$XDG_CONFIG_HOME/software-factory` (`~/.config/software-factory`).
  - `audit.json` holds the result: commit, status, findings, notes, and the findings filed as issues.
  - `scan/` holds the plugin's own report and output.
- Nothing about an open vulnerability lands in a commit or on GitHub until you file it.
- An audit that couldn't scan (plugin missing, timeout, cancelled) is kept too, with the reason.
  After a timeout the plugin's partial output stays in `scan/`, but its findings aren't listed.
  A scan that ended with an error but wrote a report counts, with a note that it may be incomplete.

## Filing a finding

- `factory audit show` prints each finding's evidence, which is what the issue will say: read it before you file.
  It is the scan's agents' text, written from the repository's content.
- `factory audit file <finding>` opens an issue with what the scan found, in the Why / What / Acceptance criteria shape, so a run can fix it.
  Queue it with `factory queue <number>`.
- You open the issue, so it counts as yours for [trust](trust.md).
- A finding is filed once, across audits (a later audit reports the same id); `factory audit show` notes the issue next to it.
- On a public repository it refuses: anyone could read the issue and use the vulnerability before it is fixed.
  Report it privately with a [security advisory](https://docs.github.com/en/code-security/security-advisories) instead, or pass `--public` if it is safe to share.
- An internal repository counts as private, though everyone in its enterprise can read its issues.
- Mentions in the text are quoted and local paths left out.

[All docs](README.md)
