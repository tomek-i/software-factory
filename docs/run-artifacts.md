# Run artifacts

Every run keeps its files in `.factory/runs/<run>/`.
Back to the [README](../README.md); the stages that write them are in [Pipeline](pipeline.md).

## Files

- the issue;
- `triage.md`, the triage verdict;
- `spec-N/refine.md`, the refined spec of spec round N;
- `spec-N/critic.md`, the spec critic's verdict on round N;
- the build report;
- `round-N/checks.md` and `checks.log`, the quality gate's report and output;
- `round-N/change.diff`, the change the reviewers and verifier read;
- `round-N/review-<lens>.md`, one per review lens;
- `round-N/verify.md`, the verifier's verdict;
- `round-N/capture.md`, the capture agent's plan;
- `round-N/capture-report.md`, the capture report;
- `round-N/capture/`, the screenshots, video and app logs;
- `round-N/capture/narrate/`, the narrated walkthrough's scene and logs;
- `round-N/resync/`, re-sync conflicts (`conflicts.md`) and re-checks (`checks.md`);
- `approval.md` and `approval.diff`, the approver's decision and the final diff it read;
- `learn.md`, the learner's proposed lessons;
- the agent prompts, permission profiles and full stream logs (`agent/`).

## Reading them

- `factory show <run>` summarises them.
- `factory show <run> <file>` prints one.
- When a run waits at a gate, `factory run` names the file to read.
  - For example `factory show <run> critic` at the `critic` gate.
- The run folder is never removed when a run ends (see [Cleaning up finished runs](runs.md#cleaning-up-finished-runs)).
