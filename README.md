# Muon

A local, task-first workspace for directing coding agents. Describe work to a Claude Code chief of staff, organize tasks and subtasks, approve their RFCs, and review verified results. The interface shows outcomes and milestones, never tool-call or reasoning transcripts.

## Run

Requires **Node.js 22.13+** and Git. Install and sign in to **Claude Code** (required for the chief of staff); Claude requires `--restricted` support (2.1.248+). Muon installs its tested **Codex CLI** as a project dependency. Use your existing Codex login, or run `npx codex login` after installation.

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. Open **Settings**, set the absolute path to a Git repository root with at least one commit, select your default agent, and set the concurrency limit. A task created in **Todo** automatically starts planning. **Backlog** captures work without starting an agent.

The app uses the existing local CLI login; no API key needs to be copied into Muon. Local refers to the app, database, orchestration, and agent processes. The agents still use their configured model services.

For a populated, interactive demo without any model calls or repository changes:

```sh
npm run demo
```

The demo has its own database, starts with dispatch paused, and clearly labels its illustrative plans/results. Enable dispatch to try the complete approval workflow. Stop the current server before switching between demo and real modes.

For a built local app:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:4310**. Development runs React on 5173 and Hono on 4310; the frontend proxies `/api` to Hono. Production serves both from Hono. This version is a local browser app; desktop packaging is not included.

## The workflow

1. Create a task yourself or ask the chief of staff to create and prioritize work.
2. The dispatcher selects eligible Todo tasks by priority, then creation time, up to the configured system limit. The chief consumes one slot too.
3. Muon creates an isolated Git worktree. The selected agent inspects the code with read-only planning permissions and returns an RFC.
4. The task pauses in **In review** and releases its agent slot. **Attention** points you to the RFC. Approve the exact revision, or request changes to receive a new revision.
5. The approved task queues for **Building**, then **Verification**, reusing its worktree and provider session. Muon validates the worktree identity before each phase.
6. Passing verification creates a **Done** task with test steps, final summary, stored screenshots/recordings when provided, and Git-derived changed files. Failures and unrun checks become **Blocked** and appear in Attention.

Reading an approval does not resolve it. Completion notifications can be acknowledged. When every task is Done or Canceled and at least one is verified, Attention also reports project completion with the canceled count. Adding new work clears that project completion notice. Done means verification passed; Muon keeps the branch/worktree for your review and does not merge, push, or deploy it.

Choose **Task group** for an organizational parent: it never launches an agent and completes when its nonempty set of children and dependencies are Done. Nested groups are supported. Adding new work reopens a completed group. A canceled child remains visible and prevents successful group completion until you explicitly remove it from the group or cancel the group.

Coding subtasks have independent RFCs, worktrees, and verification. They run independently unless dependencies connect them. A coding parent waits for children, then runs its own approved integration workflow. Muon exports completed dependency changes into immutable patches attached to the integration RFC, including uncommitted and untracked files. The Plan tab shows these inputs and downloads the exact patches; building uses the snapshots you reviewed. Completion does not merge sibling branches automatically. A canceled dependency or child does not unblock parent coding work until you resolve its scope.

The chief can create groups and coding tasks in one response, edit unstarted task metadata and relations, queue, prioritize, cancel, recover failures, and summarize results. Its structured actions go through the same task service as the UI. It cannot approve RFCs or mark coding work verified.

Blocked tasks offer **Retry**, **Fix implementation**, and **Request new RFC**. Retry repeats the failed phase. Fix returns an approved build or verification failure to building, then verifies again. A new RFC revokes the old approval and pauses for your new decision. Each attempt retains its evidence, and the Evidence tab distinguishes the latest attempt from earlier failures.

## Local data and recovery

By default data lives in `.muon/local/` (demo: `.muon/demo/`):

- `muon.sqlite`: scoped projects, settings, tasks, run history, RFC decisions, evidence metadata, attention, and final chief messages. SQLite uses WAL and optimistic task revisions.
- `worktrees/`: persistent worktree manifests and checkouts, namespaced by repository identity and task ID.
- `artifacts/`: copied verification images, videos, and text files, retained independently of agent processes.
- `server.lock`: prevents multiple dispatchers opening the same data directory.

Normal shutdown stops agents and releases the local instance lock. On restart, interrupted tasks become Blocked, keep their worktrees, and pause automatic dispatch; they are never assumed successful. After a hard crash, inspect and stop any surviving agent processes before resuming dispatch or retrying a task. Muon cannot prove orphan process exit across a killed server. If an agent cannot confirm shutdown in a running server, its capacity slot stays reserved.

Worktrees start from the repository's committed `HEAD`; uncommitted main-checkout changes, ignored dependencies, secrets, and local setup files are not copied. Agents plan necessary setup, then install dependencies within their own checkout after RFC approval. Sandbox/permission failures are surfaced in the task. Worktrees are retained and there is no automatic cleanup or merge action. Dependency patches are bounded to 256 KiB each and 512 KiB combined; larger integrations stop with an explanation instead of receiving incomplete code.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MUON_DATA_DIR` | `.muon` | Parent directory for local/demo state |
| `MUON_REPOSITORY_PATH` | empty | Initial repository path; existing settings take precedence |
| `MUON_CLAUDE_EXECUTABLE` | `claude` | Claude Code executable |
| `MUON_CLAUDE_ALLOWED_DOMAINS` | `registry.npmjs.org` | Comma-separated dependency/test hosts allowed during approved Claude builds and verification |
| `MUON_CLAUDE_ALLOW_LOCAL_SERVERS` | unset | Set to `1` when approved Claude tasks need to start a local preview/test server |
| `MUON_CODEX_EXECUTABLE` | project-managed Codex CLI | Optional override for a specific Codex executable |
| `MUON_DEMO` | unset | Set to `1` for the isolated demo |
| `PORT` | `4310` | Hono port; update the Vite proxy if changing it during development |

The app binds to loopback and rejects foreign hosts/origins. It has a fixed local owner, not a network authentication system. Do not expose this local server publicly.

Claude's default command network policy permits the public npm registry. Projects using another package registry, browser downloads, or network integration tests need their specific hosts added to `MUON_CLAUDE_ALLOWED_DOMAINS`. Add localhost hosts and enable `MUON_CLAUDE_ALLOW_LOCAL_SERVERS` when your project tests start a local web server. These are explicit owner runtime settings; missing permission blocks a task with retained results and a recovery action. Codex permits outbound dependency access during approved build/verification phases. Neither provider grants source edits during planning.

## Architecture and validation

TypeScript, React, Tailwind CSS 4, shadcn-style Radix primitives, Hono, and Node's SQLite driver. Provider processes, worktrees, persistence, identity, artifacts, and dispatch have explicit contracts. The UI supports one project and one owner; stored IDs and repository scopes reserve the path to collaboration.

- [Linear product study and adapted PRD](docs/linear-product-study.md)
- [Implementation architecture and cloud boundaries](docs/architecture.md)
- [Orca adapter provenance and runtime decisions](docs/agent-runtime.md)
- [Acceptance against all 13 requirements](docs/requirements-acceptance.md)
- [Actual Codex workflow validation](docs/codex-live-validation.md)
- [Actual Claude validation](docs/claude-live-validation.md)
- [Browser workflow and media validation](docs/browser-validation.md)

```sh
npm run typecheck
npm test
npm run build
```

Tests use actual temporary SQLite databases and Git repositories plus controlled provider executables. They cover approval races, dispatch capacity, dependencies, group rollups, chief mutations, recovery, cancellation, restart recovery, provider framing, artifact containment, recording byte ranges, and HTTP validation. They do not spend model credits. Separate opt-in live validation scripts exercise the real authenticated providers in isolated repositories and independently rerun their tests; see the linked acceptance records.

`npm run test:browser` runs the complete browser acceptance with controlled agents, actual SQLite/Git worktrees, and recorded media. Install its dedicated Chromium runtime once with `npx playwright install chromium` if it is not already present. `npm run test:live:claude`, `npm run test:live:codex`, `npm run test:live:chief`, and `npm run test:live:dependencies` use your authenticated provider accounts and make real model calls.
