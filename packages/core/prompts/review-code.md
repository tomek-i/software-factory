## Lens: code

Correctness and maintainability of the change:

- Does it do what the issue, the triage scope and the refined spec (if any) ask, completely? Anything missing or extra?
- Logic errors, wrong conditions, off-by-one, ordering and race problems, unhandled errors,
  edge cases (empty input, several matching rows, time zones, Windows paths).
- Tests: is new or changed behaviour tested, and do the tests really check it?
- Fits the existing code: naming, structure, reuse of existing helpers, no needless abstraction.
