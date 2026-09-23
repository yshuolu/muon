# Browser acceptance validation

Passed 2026-09-23T23:47:10.922Z.

This is an isolated product acceptance fixture with controlled agent outcomes, real HTTP and SQLite, real Git worktrees, and a dedicated headless Chromium browser. It does not claim authenticated Claude/Codex execution. No user browser tab or project database was used.

- Task groups are created through the UI and have no agent, RFC, or fabricated verification.
- Subtask priority and parent persist; pause is explained; building cannot launch before explicit owner approval.
- Two plan comments preserve conversation and RFC versions across reloads; rejected sends retain the draft, stale revisions cannot be approved, and review controls work on mobile.
- Repair preserves the approved RFC; real Git changes and actual browser screenshot/video are imported through TaskService and LocalArtifactStore.
- Latest evidence excludes historical failures, and the prior failed attempt remains reviewable.
- Original screenshot renders and expands; actual video loads, plays, seeks, serves HTTP byte ranges, and downloads unchanged.
- Files list uses actual worktree changes; group rollup reopens for new children and handles canceled scope removal without inventing success.
- Integration RFCs show immutable dependency file snapshots and download the exact reviewed patch bytes.
- Chief CLI operations create persisted task links and browser Back returns to the Chief conversation.
- No browser page errors were observed.
- SQLite reopen retains the completed task, RFC discussion and revisions, attempt history, and media references.

## Retained artifacts

- Fixture database, Git repository, worktrees, imported artifacts, and JSON report: `/Users/yshuolu/Develop/muon/.claude/worktrees/drifting-conjuring-shell/.muon/validation/browser-GQjlvj`
- Full browser recording: `/Users/yshuolu/Develop/muon/.claude/worktrees/drifting-conjuring-shell/.muon/validation/browser-GQjlvj/recordings`
- Downloaded original recording: `/Users/yshuolu/Develop/muon/.claude/worktrees/drifting-conjuring-shell/.muon/validation/browser-GQjlvj/downloaded-recording.webm`
- [01-rfc-review.png](/Users/yshuolu/Develop/muon/.claude/worktrees/drifting-conjuring-shell/.muon/validation/browser-GQjlvj/01-rfc-review.png)
- [01b-plan-conversation.png](/Users/yshuolu/Develop/muon/.claude/worktrees/drifting-conjuring-shell/.muon/validation/browser-GQjlvj/01b-plan-conversation.png)
- [01c-plan-conversation-mobile.png](/Users/yshuolu/Develop/muon/.claude/worktrees/drifting-conjuring-shell/.muon/validation/browser-GQjlvj/01c-plan-conversation-mobile.png)
- [02-recovery-controls.png](/Users/yshuolu/Develop/muon/.claude/worktrees/drifting-conjuring-shell/.muon/validation/browser-GQjlvj/02-recovery-controls.png)
- [03-expanded-screenshot.png](/Users/yshuolu/Develop/muon/.claude/worktrees/drifting-conjuring-shell/.muon/validation/browser-GQjlvj/03-expanded-screenshot.png)
- [04-recording-playback.png](/Users/yshuolu/Develop/muon/.claude/worktrees/drifting-conjuring-shell/.muon/validation/browser-GQjlvj/04-recording-playback.png)
- [05-group-completed.png](/Users/yshuolu/Develop/muon/.claude/worktrees/drifting-conjuring-shell/.muon/validation/browser-GQjlvj/05-group-completed.png)
- [06-frozen-dependency-inputs.png](/Users/yshuolu/Develop/muon/.claude/worktrees/drifting-conjuring-shell/.muon/validation/browser-GQjlvj/06-frozen-dependency-inputs.png)

Rerun after building: `pnpm exec tsx scripts/browser-live-check.ts`. Install the dedicated Chromium test runtime once with `pnpm exec playwright install chromium`.
