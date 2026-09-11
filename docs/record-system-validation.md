# REST and CLI system-of-record validation

Validated 2026-09-08T22:06:34.244Z against Claude Code 2.1.265.

## Real local chief

`pnpm run test:live:chief` ran two authenticated Claude turns against an isolated Git repository, actual Hono HTTP server, SQLite database, production Claude adapter, temporary scoped CLI launcher, and required Bash sandbox. The CLI called the REST API through the sandbox HTTP proxy; there was no direct database or final-response action executor.

- The first turn created an organizational group and two coding subtasks, persisted parent/dependency links, queued the children, and updated an existing task's title, priority, and labels.
- The second turn canceled one child and moved the other to Backlog with urgent priority. Unchanged metadata and all relationships were asserted independently.
- Persisted affected IDs matched chief result links; the peak shared capacity was one, and both sessions released their slots.
- The repository remained byte-for-byte unchanged, the dispatcher stayed paused, no RFC was approved, and reopening SQLite returned the same task records.
- Final results were Markdown. All mutations completed through CLI requests before final replies were stored.

Report: `/private/var/folders/48/v01qm3js6gxf1cd8zzhbpg7r0000gn/T/muon-chief-live-y0VecC/result.json`

The initial live probe exposed Node 22 fetch bypassing the sandbox proxy. The CLI now explicitly uses the configured proxy, ignores NO_PROXY in required-sandbox mode, and refuses a missing proxy. The successful run above used the fixed transport; permissions were not widened and no unsandboxed fallback was added.

## Regression and browser checks

The regression suite covers scoped resources and identifiers, input validation, exact RFC approvals, CLI JSON/stdin and downloads, execution outside the repository, authorization, cancellation/expiry, preservation of admitted writes, partial agent failure, inert final JSON, and the shared browser fetch receiver. Real temporary HTTP and proxy fixtures verify that credentials remain attached to the intended API and redirects are rejected.

The complete browser fixture passed all ten acceptance groups with zero page errors. It used controlled provider outcomes, actual HTTP/SQLite/Git, an actual CLI process for chief task creation, real screenshot/video artifacts, and exact patch downloads. This browser fixture is distinct from the authenticated chief run above.

Browser report: `/Users/darren_lu/Develop/experimental/muon/.muon/validation/browser-WdzQpQ/report.json`

The running owner's workspace was only read through `muon health`, `muon project`, and `muon tasks list`; it still contains zero tasks. All test records are isolated from that database.

## Current boundary

The owner UI and owner CLI trust the local loopback service. Chief sessions have short-lived scoped credentials and a pinned, read-only launcher. Their API authority cannot approve RFCs, submit owner review feedback, change settings, clear attention, or start another chief request. Hosted authentication, project membership, deployment policy, and distributed execution remain future implementations using this REST contract.
