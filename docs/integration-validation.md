# Task integration validation

Validated on September 27, 2026 (UTC).

Every coding task already ran in its own Muon-owned Git worktree on a `muon/<task ID>` branch; what was missing was the way back. Verified work now lands on the owner's branch automatically, and the task keeps its commit stack.

- `pnpm run typecheck` passed.
- `pnpm test -- --run` passed.
- `pnpm run build` passed. Vite reports its existing bundle-size advisory for the main chunk.
- Worktree provider tests, against real Git repositories: `commits()` lists only the task branch's own commits; `integrate()` commits work the agent left uncommitted (one commit named after the task, excluding managed input copies), rebases onto the branch checked out in the repository even after that branch moved on, fast-forwards it so the repository's working tree receives the files with a clean status, and afterwards reports no pending commits. It refuses a checkout with uncommitted tracked changes, refuses a detached checkout, and aborts a conflicting rebase leaving the repository head and the task branch exactly as they were.
- Service tests cover the commit stack recorded after building and verification, automatic integration when verification passes (activity line, `integration.status`, branch, commits), the 409 for integrating twice, a failed integration recorded on a task that stays Done, and the retry through `integrateTask`.
- The building prompt now tells the agent to commit on the task branch as it goes and never to push, switch branches, or create another worktree.

The web task view shows the commit stack on the **Changes** tab with the integration status and an **Integrate again** control after a failure, and the footer of a Done task says which branch received the commits.
