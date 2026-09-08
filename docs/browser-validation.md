# Browser acceptance validation

Passed 2026-09-08T21:04:04.025Z.

This is an isolated product acceptance fixture with controlled agent outcomes, real HTTP and SQLite, real Git worktrees, and a dedicated headless Chromium browser. It does not claim authenticated Claude/Codex execution. No user browser tab or project database was used.

- Task groups are created through the UI and have no agent, RFC, or fabricated verification.
- Subtask priority and parent persist; pause is explained; building cannot launch before explicit owner approval.
- Repair preserves the approved RFC; real Git changes and actual browser screenshot/video are imported through TaskService and LocalArtifactStore.
- Latest evidence excludes historical failures, and the prior failed attempt remains reviewable.
- Original screenshot renders and expands; actual video loads, plays, seeks, serves HTTP byte ranges, and downloads unchanged.
- Files list uses actual worktree changes; group rollup reopens for new children and handles canceled scope removal without inventing success.
- Integration RFCs show immutable dependency file snapshots and download the exact reviewed patch bytes.
- Chief final actions create persisted task links and task back-navigation returns to the Chief view.
- No browser page errors were observed.
- SQLite reopen retains the completed task, RFC, attempt history, and media references.

## Retained artifacts

- Fixture database, Git repository, worktrees, imported artifacts, and JSON report: `/Users/darren_lu/Develop/experimental/muon/.muon/validation/browser-xAE3iS`
- Full browser recording: `/Users/darren_lu/Develop/experimental/muon/.muon/validation/browser-xAE3iS/recordings`
- Downloaded original recording: `/Users/darren_lu/Develop/experimental/muon/.muon/validation/browser-xAE3iS/downloaded-recording.webm`
- [01-rfc-review.png](/Users/darren_lu/Develop/experimental/muon/.muon/validation/browser-xAE3iS/01-rfc-review.png)
- [02-recovery-controls.png](/Users/darren_lu/Develop/experimental/muon/.muon/validation/browser-xAE3iS/02-recovery-controls.png)
- [03-expanded-screenshot.png](/Users/darren_lu/Develop/experimental/muon/.muon/validation/browser-xAE3iS/03-expanded-screenshot.png)
- [04-recording-playback.png](/Users/darren_lu/Develop/experimental/muon/.muon/validation/browser-xAE3iS/04-recording-playback.png)
- [05-group-completed.png](/Users/darren_lu/Develop/experimental/muon/.muon/validation/browser-xAE3iS/05-group-completed.png)
- [06-frozen-dependency-inputs.png](/Users/darren_lu/Develop/experimental/muon/.muon/validation/browser-xAE3iS/06-frozen-dependency-inputs.png)

Rerun after building: `npx tsx scripts/browser-live-check.ts`. Install the dedicated Chromium test runtime once with `npx playwright install chromium`.
