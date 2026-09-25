# Task scope editing validation

Validated on September 25, 2026 (UTC).

Why it was needed: the chief of staff was asked to keep Library documents out of the repository, tried to edit AGENT-2's description, and was refused with "Only unstarted coding tasks and active task groups can be edited" because auto-dispatch had already started planning. It worked around the rule by canceling AGENT-2 and creating AGENT-6, leaving a canceled subtask under the group.

- `pnpm run typecheck` passed.
- `pnpm test -- --run` passed: 362 tests in 33 files.
- `pnpm run build` passed. Vite reports its existing bundle-size advisory for the main chunk.
- Service tests cover a description edit during an active planning run (the run is aborted and recorded as canceled, the next planning run's prompt carries the new description and not the old one, and a single RFC results), refusal of an agent change or a Backlog/Todo move once the task started, refusal of scope edits after the RFC is approved, and metadata edits (labels, effort, unchanged title) while approved work runs.
- The chief test that previously expected a 400 during RFC review now checks that the chief's edit sets the pending RFC to `changes_requested`, clears the approval attention, and requeues planning, and that the task can still be canceled afterwards without any build starting.
- The chief prompt tells the agent to edit tasks in place instead of canceling and recreating them, and states the approved-RFC boundary.

The web task view follows the same rules: the Edit control appears until the RFC is approved (with a note that saving restarts planning when the task has started), priority, thinking effort, and the subtask control stay available until the task ends, and the agent and Backlog/Todo choices lock once the task starts.
