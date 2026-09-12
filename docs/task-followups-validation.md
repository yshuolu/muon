# Task follow-up validation

Validated on 2026-09-12 using Node.js 22.23.2 and pnpm 10.33.0.

## Automated checks

- `pnpm run typecheck`: passed.
- `pnpm test -- --run`: 286 tests passed across 24 files.
- `pnpm run build`: passed; Vite reports its existing advisory for a JavaScript chunk over 500 kB.
- `git diff --check`: passed.

The 19 focused task-comment tests cover first-session capture for Claude and
Codex, interruption with confirmed shutdown, session/worktree reuse, stale
results, concurrent comment and reply writes, idempotent submission, cancellation,
provider failure/retry, server restart/shutdown, and unreaped process capacity.
They also check preservation of Done/Blocked outcomes and verification evidence,
immediate reopening for a revised RFC, dependency blocking, owner approval,
repository identity, bounded unanswered comments, and authorized discussion
assets without expanding approved implementation inputs.

Adapter tests use controlled executables to exercise the actual process/protocol
boundary, including early session callbacks and read-only discussion permissions
even when ordinary execution has full access. HTTP/CLI tests cover scoped reads,
owner-only mutations, input validation, retries, and compatibility with existing
RFC comments.

## Browser checks

An isolated Vite app and API fixture passed nine browser checks without runtime
errors: persisted conversation, draft retention across failed submissions and tab
switches, stable request IDs, keyboard sending, pending/error/retry states,
revised-RFC approval requirements, disabled plan actions during pending replies,
mobile layout, and canceled-task history. Desktop and mobile captures were
visually inspected.

Local evidence is retained in the implementation worktree under
`.muon/validation/task-comments-ui/` (`result.json`, `desktop.png`, `mobile.png`,
and `mobile-composer.png`); command logs are under `.muon-cache/verification/`.
Verification used controlled provider and browser fixtures, without sending
messages to authenticated model sessions or changing production task records.
