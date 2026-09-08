# Live Claude validation

Validated on 2026-09-08 using the installed Claude Code 2.1.263 and an authenticated local account. The actual `ClaudeCodeAdapter` and `LocalWorktreeProvider` executed the work; no mock provider or simulated task result was used.

The repeatable check is:

```sh
node --import tsx scripts/claude-live-check.ts
```

This is an opt-in integration check. It makes real Claude requests, uses the signed-in account, and requires normal local network and Claude session-storage access. It creates a small temporary Git repository, an isolated Muon task worktree, and an evidence directory. Their location is printed and retained for inspection. It never gives the coding agent the Muon or Orca repository as its working directory.

## What was verified

- Planning read the two-file repository, returned an RFC, and left the task worktree unchanged.
- After the harness explicitly approved that RFC, building changed the implementation and added regression tests.
- Verification executed `node --test math.test.mjs` inside the task worktree.
- Planning, building, and verification reused one Claude session and one persistent task worktree.
- The host independently checked positive, negative, and decimal inputs and reran the test suite. All 8 tests passed in the first validation run; a second run with the final permission/MCP options generated and passed 10 tests.
- Changed-file inspection reported exactly `math.mjs` and `math.test.mjs`, including real addition/deletion counts.
- The primary checkout still contained the original stub after the coding agent finished.

Each run stores the three final responses, independently collected test output, independent behavioral assertion output, and a structured `result.json`. Only final responses are retained by the harness; tool/reasoning transcripts are not needed for this check or the product UI.

The second successful run completed at `2026-09-08T20:54:04.144Z`. Planning took 43.7 seconds, building 15.6 seconds, and verification 24.6 seconds. Its two changed files had actual Git changes: implementation `+1/-1`, tests `+17/-0`.

## Permission behavior

Claude uses restricted mode, with only read tools during planning/chief phases. Building and verification permit edits in the assigned worktree and commands within Claude's sandbox. Permission bypass is disabled and unsandboxed commands are disallowed. Unrelated MCP configurations and hooks are disabled, and requests requiring an interactive permission response are denied instead of hanging a background task.

Approved Claude build/verification phases allow outbound access to `registry.npmjs.org` for locked npm package installation. Other hosts and local port binding remain disallowed by default; tasks requiring those capabilities will need an explicitly configured allowance. Planning and chief phases have neither command tools nor allowed sandbox network domains. Claude documents these controls in its [sandbox settings](https://code.claude.com/docs/en/settings).

In the first run Claude successfully executed the direct Node test command. Attempts to combine that command with an extra shell command to print the exit code were denied; Claude reported this accurately and used the test runner's successful result and TAP counters. The host's separate test invocation also exited successfully. A denied optional tool attempt therefore is not, on its own, evidence that a whole phase failed.

## Live chief of staff

The separate repeatable check is:

```sh
node --import tsx scripts/chief-live-check.ts
```

The successful run completed at `2026-09-08T20:56:35.943Z`. It used the real Hono HTTP handlers, `TaskService`, a persistent temporary SQLite database, and the same production `ClaudeCodeAdapter`. The dispatcher was paused so queued implementation tasks could not start during the chief check.

Two real conversation turns verified:

- The chief created an organizational group and two coding subtasks, assigned Claude, queued the children as Todo, applied labels, and resolved the parent and dependency references correctly.
- It edited an existing task's title, priority, and labels while keeping its Backlog status.
- A follow-up request canceled one child and moved its sibling to Backlog with Urgent priority while preserving the other fields.
- The canceled child did not make its parent group complete.
- The shared active-agent count peaked at the configured limit of one and returned to zero.
- No RFC was approved, no coding agent started, and the source repository remained unchanged.
- A separately opened SQLite connection read the same persisted task state. User and final assistant messages were also saved, with links to affected tasks.

These checks cover the live Claude runtime, task workspace integration, and chief task management. The application's persisted approval gate, coding dispatcher lifecycle, attention, evidence import, and UI behavior also have separate service and browser checks.

## Live dependency integration and recovery

The real dependency integration task reached Done at `2026-09-08T21:19:31.076Z`; independent host validation completed at `2026-09-08T21:19:32.157Z`. The retained fixture is:

```text
/private/var/folders/48/v01qm3js6gxf1cd8zzhbpg7r0000gn/T/muon-dependency-live-h0GZZZ
```

Its `result.json` preserves the initial blocked verification. The successful recovery and complete immutable history are in:

```text
/private/var/folders/48/v01qm3js6gxf1cd8zzhbpg7r0000gn/T/muon-dependency-live-h0GZZZ/result-retry.json
```

The prerequisite was an independently verified, host-created fixture. The integration task itself used real Claude calls through Muon's HTTP handlers, task service, SQLite store, dispatcher, and owner RFC approval. Planning and building reused a session; verification recovery intentionally started a fresh session on the same task, RFC, and worktree.

- A recursively nested prerequisite supplied one deduplicated, frozen Git patch, including an untracked source file.
- Planning made no file changes and installed no dependencies before approval.
- Approved building installed locked TypeScript 5.9.2 in the fresh worktree using `npm ci` and a local npm cache. Only `registry.npmjs.org` was allowed; local port binding stayed disabled.
- The prerequisite's sentinel was changed from `73129` to `99999` after RFC approval. The integration used the approved `73129` snapshot while leaving the source's later `99999` unchanged.
- Actual Claude verification passed all seven npm tests and the TypeScript check. The host independently reran both commands and passed four additional behavioral assertions.
- The original checkout remained unchanged. The task's three changed files were `math.mjs`, `math.test.mjs`, and `offset.mjs`.

This run required verification recovery. An optional inline diagnostic command was denied and accurately retained in the earlier evidence; all prior failed runs and evidence remained unchanged. A subsequent attempt exposed a service bug that treated a skipped optional note as a skipped required test. The corrected gate evaluates test evidence, while preserving notes. The final verification reran every required check successfully and disclosed the optional limitation. Required failed or skipped tests still block completion.

See [dependency integration](dependency-integration.md) for the repeatable acceptance and recovery commands.
