# Session workflow validation

Date: September 11, 2026. Implementation branch: `codex/session-workflows`.

The implementation adds Brainstorm, Research, and parameterized Develop workflows,
durable logical sessions, shared session input, and a compact planning toolbar.

## Automated checks

- `pnpm run typecheck` — passed.
- `pnpm test -- --run` — 217 tests passed across 19 files.
- `pnpm run build` — passed. Vite reports a JavaScript chunk above its 500 kB
  advisory threshold; this does not fail the build.
- `git diff --check` — passed.

Coverage includes repository-free Brainstorm/Research, owner-approved plan reuse,
fresh provider conversations between sessions, same-session retries and review
turns, immutable dependency results, imported-plan replanning, forged dispatch
rejection, scoped API/CLI access, restart recovery, and scratch-directory safety.
Provider protocol tests use controlled processes; they are not live model runs.

Local command logs are retained under `.muon/validation/session-workflows/`.

## Browser checks

Eight browser checks passed with mocked API responses and no page errors:

- Research displays its saved result and actual session, without coding gates.
- Research detail and workflow creation fit a 390 px viewport.
- Approved-plan selection previews the RFC and preserves the reviewed scope.
- An empty planning conversation can create a Brainstorm task.
- Planning has a 54 px page toolbar and one accessible page heading.
- The mobile toolbar and composer remain visible without horizontal overflow.
- Sending a message, opening workflow selection, and returning to tasks work.
- An imported-plan task can move from Backlog to Todo while its scope stays locked.

Screenshots and machine-readable results are retained under
`.muon/validation/session-workflow-ui/` and
`.muon/validation/planning-header-ui/`. These captures use fixture data and do not
represent an authenticated provider executing a task.

Live provider acceptance scripts were updated for session boundaries but were
not executed for this change.
