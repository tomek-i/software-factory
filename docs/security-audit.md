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

## What an audit does

- It fetches the default branch and scans it as merged on GitHub, in a temporary worktree outside the repo.
  Your checkout and its uncommitted changes are never scanned or touched.
- The settings come from the default branch's `.factory/config.yaml`, like a run's: [`security.audit_effort`](configuration.md#security) and `security.audit_timeout_min`.
- The model is the scan's: `models.reviews.security-scan`, else Opus.
- The scan's agents run as for the [deep security scan](pipeline.md#deep-security-scan): your Claude Code login and user settings, no tokens, `gh` logged out, no sandbox.
- The plugin verifies each finding before it reports it.
  CRITICAL is critical, HIGH and MEDIUM are major, LOW is minor.
- Ctrl+C stops the scan and removes the worktree.

## Where the results go

- Each audit gets a folder in the factory's data folder, outside the repository: `audits/<owner-repo>/<started>/`.
  - On Windows that is `%LOCALAPPDATA%\software-factory`, elsewhere `$XDG_CONFIG_HOME/software-factory` (`~/.config/software-factory`).
  - `audit.json` holds the result: commit, status, findings, notes, and the findings filed as issues.
  - `scan/` holds the plugin's own report and output.
- Nothing about an open vulnerability lands in a commit or on GitHub until you file it.
- An audit that couldn't scan (plugin missing, timeout, cancelled) is kept too, with the reason.
  A scan that ended with an error but wrote a report counts, with a note that it may be incomplete.

## Filing a finding

- `factory audit file <finding>` opens an issue with what the scan found, in the Why / What / Acceptance criteria shape, so a run can fix it.
  Queue it with `factory queue <number>`.
- You open the issue, so it counts as yours for [trust](trust.md).
- A finding is filed once; `factory audit show` notes the issue next to it.
- On a public repository it refuses: anyone could read the issue and use the vulnerability before it is fixed.
  Report it privately with a [security advisory](https://docs.github.com/en/code-security/security-advisories) instead, or pass `--public` if it is safe to share.
- Mentions in the text are quoted and local paths left out.

[All docs](README.md)
