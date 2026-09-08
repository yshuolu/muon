# Integrating completed task dependencies

Coding tasks keep separate worktrees. Marking a prerequisite Done never merges its changes into another task's checkout. Integration tasks instead receive bounded, immutable snapshots of the actual prerequisite changes with their RFC.

`WorkspaceProvider.exportChanges` supplies Git patches containing committed, staged, unstaged, and untracked changes relative to the source task's original base. Binary files, executable modes, deleted files, symlinks, and non-UTF-8 content retain their original bytes. Non-UTF-8 patches are represented as base64 with an explicit encoding. The local exporter uses a private temporary Git index and object directory; it does not stage files, create commits, or change the source worktree's index or contents. Orchestrator Git commands use an empty hooks directory, so preparing a worktree for planning cannot trigger configured checkout hooks.

Only completed related coding tasks supply inputs. Dependencies on organizational groups expand recursively to their completed coding leaves, with duplicate sources removed. Source workspace identity, branch, and base are validated; a before/after content check rejects sources that change during export. The adapter never gains access to sibling working directories.

Each RFC stores its `dependencyInputs`, including source task identity, capture time, base/head commits, exact patch, changed-file list, and SHA-256 digest. Building and verification reuse that approved RFC's saved inputs. External edits to a prerequisite after review do not change what the coding agent receives. Replanning captures a new set of inputs that requires a new owner approval. Older RFCs without required dependency snapshots must be replaced before integration can proceed.

Exports are bounded to 256 KiB of patch data per prerequisite, 512 KiB of combined encoded patch context per integration, 512 changed files per source, and 32 MiB of inspected source content per export. Exceeding a bound blocks the integration task with an explanation; no truncated or partial patch is passed to an agent. Submodule and special-file integration also requires explicit handling rather than an incomplete patch.

Fresh worktrees must perform their own environment setup. Planning records the needed setup; installation runs only after RFC approval, using committed manifests and lockfiles. Dependencies and caches remain local to the task checkout, and source changes are integrated only within the approved scope. Claude's default approved-phase network allowlist covers `registry.npmjs.org`; additional registries, browser download hosts, and local test-server binding are not enabled by this change. A denied setup step must be reported as failed/skipped verification and requires attention.

The opt-in live acceptance check is `node --import tsx scripts/dependency-live-check.ts`. It seeds an independently verified prerequisite fixture, then runs the real Claude integration task through Muon's HTTP handlers, task service, SQLite storage, RFC approval, build, and verification. It also checks a fresh TypeScript installation, actual tests, source isolation, and reuse of a reviewed snapshot after the prerequisite is deliberately changed.

## Recorded live acceptance

On 2026-09-08 the real Claude integration task completed with seven passing npm tests, a passing TypeScript check, and four additional host behavioral assertions. It installed TypeScript 5.9.2 in the fresh worktree using the npm-registry-only network allowance. The approved dependency sentinel remained `73129` in the integration even after the prerequisite was changed to `99999`. Source contents, the original checkout, and the approved RFC inputs remained unchanged.

The retained fixture and final recovery report are:

```text
/private/var/folders/48/v01qm3js6gxf1cd8zzhbpg7r0000gn/T/muon-dependency-live-h0GZZZ
/private/var/folders/48/v01qm3js6gxf1cd8zzhbpg7r0000gn/T/muon-dependency-live-h0GZZZ/result-retry.json
```

The first verification was blocked after an optional inline diagnostic was denied. Recovery retained every prior failed run and evidence item, reused the same approved RFC, frozen patches, task, and worktree, and reran all required checks through a fresh Claude session. A service correction ensures optional notes do not count as failed/skipped test evidence; any required failed or skipped test continues to block completion. The report contains both the original history and the successful recovery; `result.json` still records the original blocked attempt.

To recover a blocked verification from a fixture created by the live check, run:

```sh
node --import tsx scripts/dependency-live-retry.ts /absolute/path/to/muon-dependency-live-fixture
```

The recovery harness validates that the supplied directory is one of the temporary acceptance fixtures, invokes the normal task retry API, and independently reruns the npm suite, local TypeScript compiler, and behavioral assertions. It makes real Claude requests and retains the prior history. The completed fixture above is retained for inspection; rerunning recovery requires a fixture currently blocked at verification.
