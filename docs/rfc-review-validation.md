# RFC review validation

Validated on September 27, 2026 (UTC).

- `pnpm run typecheck` passed.
- `pnpm test -- --run` passed: 364 tests in 33 files.
- `pnpm run build` passed. Vite reports its existing bundle-size advisory for the main chunk.

The RFC in a task's Plan tab is now reviewed like a Library document. It renders through the same document reader, so it gets the section outline, and the same selection-anchored comments: select a passage for **Comment**, or use **On RFC** for the whole plan. Comments are collected (`POST /tasks/:task/plan-discussion` with `revise: false`), can be edited or deleted while pending, and **Revise RFC · N comments** (`POST /tasks/:task/plan-discussion/revise`) sends them to the task's agent in one planning turn. The agent returns one reply per comment (`replies[{ id, kind, content }]`) with the revised RFC; each reply is stored beside its comment with `replyToIds` and `kind`, so the sidebar shows Answered, Changed, or Declined next to what you wrote. Highlights turn green once answered. Comments made through the CLI or the API without `revise: false` keep the previous one-step behavior.

- Service tests cover collecting anchored and whole-RFC comments without triggering a revision, editing and deleting pending comments (404 for unknown, 409 once answered), the batched revision request (409 without comments, feedback carrying the quoted passages, prompt listing each comment's id and selected text), per-comment replies paired by id, and the refusal of a second revision request when nothing is pending. Existing revision tests still pass with the legacy `reply` envelope.
- Web tests cover the review-state gate: approval is blocked while a draft is open or comments are unsent.
- The former chat-style Plan discussion component is replaced by the review sidebar; the comment card, selection watcher, and highlight helpers are shared with the Library reader.
