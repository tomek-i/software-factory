# Lessons

Approved lessons from past runs. Agents read this file before they start.

- When building a RegExp from text, escape every special character with a full escapeRegExp (`/[\\^$.*+?()[\]{}|/-]/g` -> `\\$&`), never a single-character replace; CodeQL flags partial escaping on the PR and a human has to send the run back.
- Queue order is `queued_at` first, then `queue_seq` (packages/core/src/scheduler/scheduler.ts); never say in docs or comments that a new `queue_seq` puts an issue 'at the end' of the queue.
- When documenting agent permissions, check `permissionProfile` in packages/core/src/agents/prompts.ts. Only writes, the shell and the web are limited; reads are unrestricted except the issue writer's denied folders. Label inputs as 'given', never as read limits.
