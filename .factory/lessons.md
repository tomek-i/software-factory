# Lessons

Approved lessons from past runs. Agents read this file before they start.

- When building a RegExp from text, escape every special character with a full escapeRegExp (`/[\\^$.*+?()[\]{}|/-]/g` -> `\\$&`), never a single-character replace; CodeQL flags partial escaping on the PR and a human has to send the run back.
