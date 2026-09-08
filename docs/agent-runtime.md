# Agent runtime and task workspaces

Muon owns the task workflow, execution limits, approvals, workspaces, and durable results. Claude Code and Codex are replaceable execution providers. `src/runtime/index.ts` is the boundary; the HTTP service and UI never consume provider transcripts.

## Contracts

`AgentAdapter.run()` accepts a provider, workflow phase, prompt, absolute working directory, optional provider session ID, and cancellation signal. It returns final text and a provider session ID. `available()` checks whether the selected executable answers `--version`; it does not prove authentication, account capacity, or sandbox readiness.

The adapters do not decide whether an RFC was approved. The application service must enforce the owner approval gate before invoking a building run, pass the approved RFC into that run, and persist the returned result. The same Claude adapter executes chief-of-staff requests. Its final JSON is interpreted and validated by the application service; the agent does not directly write the task database.

The interfaces deliberately contain no Hono, React, SQLite, terminal, or desktop dependencies. A remote execution provider can implement the same contract. A future distributed dispatcher must add a durable lease and fencing token around a run; the current local service remains the single execution owner. Project and user scope belongs to the application service and persisted task, rather than ambient global adapter state.

## What was copied from Orca

Source checkout inspected: `../orca`, commit `0ba7f8dc8d2dca757e51d4e4c25ff3539fc3eb4d`.

| Orca source | Muon destination and adaptation |
| --- | --- |
| `src/shared/main-process-ndjson-framer.ts` | Copied into `src/runtime/ndjson-framer.ts`, with a provenance comment. Retains UTF-8 byte bounds, partial-frame handling, oversized-record rejection, and encoding. |
| `src/main/claude/claude-structured-item-translation.ts` | Extracted the object and text guards into `protocol-values.ts`; discarded UI block, thinking, tool, and journal translation. |
| `src/main/codex/codex-app-server-session.ts` | Adapted the framed stdio transport, initialize/initialized handshake, numeric request correlation, bounded stderr, early-exit errors, deadline, and EOF/termination lifecycle into `json-process.ts` and `codex-adapter.ts`. |
| `src/main/codex/codex-app-server-record-reader.ts` | Retained Node UTF-8 stream decoding before incremental framing; no renderer backpressure or transcript subscriber. |
| `src/main/codex/codex-structured-thread-open.ts` | Preserved named-thread validation and refusal when resume returns a different identity. |
| `src/main/codex/codex-structured-turn-start.ts` | Preserved support for a turn ID returned by the start response or a subsequent `turn/started` notification. |
| `src/main/claude/claude-stream-json-connection.ts` and `claude-structured-launch-resolution.ts` | Adapted Orca's structured Claude CLI boundary and session resume behavior to direct headless streaming JSON, extracting only the result frame. |

This is an extraction, not a wholesale import of Orca's runtime. The current Orca Claude implementation internally loads the Anthropic Agent SDK and provides account coordination, interactive controls, descendant tracking, session journals, and desktop integrations. Muon's smaller adapter calls the installed Claude executable directly. It keeps the same structured protocol, removes those Orca dependencies, and adds Muon's fixed phase permissions. Muon currently uses the user's existing CLI authentication and provider configuration; it has no managed account switching.

## Provider execution

Claude runs headless with `--output-format stream-json --verbose`, strict MCP configuration, and noninteractive permission handling. Only the successful `result` frame becomes application output; errors, malformed protocol, missing final output, and premature process exit reject the run. Session IDs are retained for `--resume`. This follows the official [headless interface](https://code.claude.com/docs/en/headless).

Planning and chief-of-staff runs use Claude plan mode and restrict built-in tools to Read, Glob, and Grep. They cannot run Bash or edit source. Building and verification use accept-edits mode with the Bash sandbox required, automatic permission only for sandboxed commands, and no unsandboxed retry. Restricted mode confines built-in file tools to working directories; MCP tools and configured hooks are disabled. No phase uses bypass-permissions. Current Claude Code is required: `--restricted` was introduced in 2.1.248; live validation used 2.1.263. See the [CLI reference](https://code.claude.com/docs/en/cli-reference), [permission modes](https://code.claude.com/docs/en/permission-modes), and [sandbox configuration](https://code.claude.com/docs/en/sandboxing).

Claude sandbox support requires macOS, or Linux/WSL2 with the provider's sandbox dependencies installed. Unsupported platforms or unavailable sandboxing fail the run. Protected paths and unapproved actions can also fail; the task should ask for owner attention with that error. User/managed provider settings may impose additional restrictions.

Approved Claude phases allow `registry.npmjs.org` by default so fresh Node/TypeScript worktrees can install locked dependencies. The owner can configure additional named hosts through `MUON_CLAUDE_ALLOWED_DOMAINS` and local preview/test listeners through `MUON_CLAUDE_ALLOW_LOCAL_SERVERS=1`. Planning/chief phases retain read-only tools regardless of these options. The adapter accepts the same explicit options programmatically; unrestricted wildcard outbound access is not a default or accepted catch-all.

Codex runs its app-server over newline-delimited JSON-RPC. Muon installs a tested CLI version as a project dependency and invokes it with Node, preserving the owner's login/model configuration. `MUON_CODEX_EXECUTABLE` can explicitly select another executable. Each run initializes the connection, resolves effective configuration for its worktree, starts or resumes a thread, and starts one turn. Inherited MCP servers are individually disabled (an empty table would merge with existing configuration); apps, plugins, hooks, and nested agents are disabled. This keeps external actions and extra agent processes outside the task workflow.

Planning and chief runs receive a read-only sandbox. Building and verification receive workspace-write permission for the task directory with outbound network enabled for dependency installation and verification. Approval policy is `never`; unexpected permission or interactive requests fail with an attention error. `turn/completed` must report success. Final agent messages are selected by `final_answer`; older messages without phase metadata are supported. Planning accepts a completed plan item. Reasoning, commentary, tool calls, deltas, and tool output are ignored. The wire behavior was checked against the actual CLI's generated protocol and the official [Codex App Server documentation](https://learn.chatgpt.com/docs/app-server). Thread sandbox enums use `read-only`/`workspace-write`, while turn sandbox policy types use `readOnly`/`workspaceWrite`.

The transport retains only a bounded stderr tail for failure diagnostics. Cancellation terminates the owned process. POSIX launches have a dedicated process group for terminating ordinary subprocesses; native Windows uses a process-tree termination fallback. Each phase has a 30-minute ceiling and Codex RPC acknowledgements have a one-minute ceiling. If root process exit cannot be confirmed, the adapter throws the exported `AgentProcessUnreapedError` (`code: AGENT_PROCESS_UNREAPED`). The dispatcher must keep that execution slot occupied and require manual process inspection before a restart; it must not treat this error as ordinary completion. This is local process management, not container isolation; intentionally detached/daemonized processes are not guaranteed to remain in the owned process group. After a hard server crash, startup cannot prove that old agent processes exited. Interrupted tasks are blocked; inspect and stop any surviving processes before retrying them. Provider-native histories may still exist in the CLI's own storage even though Muon does not show or store them as task transcripts.

## Worktree ownership

Each coding task gets a Muon-owned Git worktree before planning. Planning, approved building, and verification reuse that checkout and branch. The workspace is independent of provider sessions, so restarting an agent or changing providers does not discard edits. Claude's native `--worktree` support would create a provider-specific lifecycle; Muon avoids depending on it and does not ask either agent to create another worktree.

`LocalWorktreeProvider.ensure()` validates an absolute Git repository root and a restricted task identifier, then creates:

```text
<storage root>/<repository identity hash>/<task ID>/
  workspace.json
  checkout/
```

The branch is `muon/<task ID>`. `workspace.json` records repository identity, branch, checkout path, and the initial commit. The base is recorded before worktree creation so a restart can recover the same baseline. Subsequent calls validate and reuse it. The repository hash prevents collisions when different projects use the same task ID. Calls within one provider are coalesced; a filesystem creation lock prevents competing local processes from creating the same checkout.

No reset, clean, force checkout, automatic merge, branch deletion, or worktree deletion is implemented. An existing unrelated branch, unexpected symlink, changed branch, mismatched metadata, or foreign checkout is refused. A creation lock left by an abrupt process death requires inspection before removal; the provider does not guess whether another creator is alive.

Changed files are calculated against the saved initial commit, not just `HEAD`. That includes commits made during building, staged changes, unstaged changes, and untracked files. NUL-delimited Git output preserves unusual filenames. Renames are presented as deletion plus addition for a stable provider-independent file list. Untracked symlinks are never followed. Binary files and untracked files larger than 16 MiB have zero line counts; zero is an unavailable textual count, not evidence of an empty change. Ignored files are omitted. Verification evidence that lives in ignored paths must be explicitly published through the artifact subsystem.

## Verification

`npm test -- src/runtime` uses fake executable processes for Claude and Codex and actual Git repositories under a temporary directory. It verifies the protocol handshake, final-only output, UTF-8 framing, readonly and workspace-write permissions, session resume, deferred turn identity, cancellation, errors, worktree reuse, base-relative changes, unusual filenames, untracked binary/symlink handling, and path/branch refusal. The tests do not invoke a paid model. Live authenticated provider runs remain an explicit acceptance check after the user configures the CLIs.
