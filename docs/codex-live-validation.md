# Codex live acceptance

Passed: 2026-09-08T21:02:07.697Z

A real authenticated Codex app-server session completed the complete Muon HTTP/task-service workflow in an isolated Git repository.

- Todo automatically dispatched to planning.
- Planning produced a real RFC and made no worktree changes.
- A stale RFC approval was rejected.
- The test owner approved the exact RFC revision.
- Building and verification used the same worktree and provider session.
- Five independent host assertions and the task's actual Node test suite passed.
- Both changed files and verification evidence were persisted.
- The original checkout was unchanged.

Local evidence: `/Users/darren_lu/Develop/experimental/muon/.muon/acceptance/codex-1788901213198/acceptance-result.json`

This test invokes the installed CLI using existing authentication. It is opt-in; run `node --import tsx scripts/codex-live-check.ts`.
