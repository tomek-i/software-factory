# Run artifacts

Everything a run writes is in `.factory/runs/<run>/`.
Back to the [README](../README.md).

## Files

- the issue;
- `triage.md`;
- `spec-N/refine.md` and `spec-N/critic.md`, one folder per spec round;
- the build report;
- `round-N/checks.md` and `checks.log`;
- `round-N/change.diff`;
- `round-N/review-<lens>.md`;
- `round-N/verify.md`;
- `round-N/capture.md`;
- `round-N/capture-report.md`;
- `round-N/capture/`: the screenshots, video and app logs;
- `round-N/resync/`;
- `approval.md` and `approval.diff`;
- `learn.md`;
- agent prompts, permission profiles and full stream logs.

## Reading them

- `factory show <run>` summarises them.
- `factory show <run> <file>` prints one.
- When a run waits at a gate, `factory run` names the file to read, for example `factory show <run> critic` at the `critic` gate.
