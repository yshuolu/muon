# Muon

A local, task-first workspace for directing coding agents. Describe work to a Claude Code chief of staff, organize tasks and subtasks, approve their RFCs, and review verified results. The interface shows outcomes and milestones, never tool-call or reasoning transcripts.

## Run

Requires **Node.js 22.13+**, **pnpm 10.33+**, and Git. Install and sign in to **Claude Code** (required for the chief of staff); Claude requires `--restricted` support (2.1.248+). Muon installs its tested **Codex CLI** as a project dependency. Use your existing Codex login, or run `pnpm exec codex login` after installation.

```sh
pnpm install
pnpm run user
```

Open **http://127.0.0.1:5173**. `pnpm run user` is the normal local user launch command: it starts the real API and web app together. Open **Settings**, set the absolute path to a Git repository root with at least one commit, select your default agent, and set the concurrency limit. A task created in **Todo** automatically starts planning. **Backlog** captures work without starting an agent.

`pnpm run dev` remains available as a development alias.

The app uses the existing local CLI login; no API key needs to be copied into Muon. Local refers to the app, database, orchestration, and agent processes. The agents still use their configured model services.

For a populated, interactive demo without any model calls or repository changes:

```sh
pnpm run demo
```

The demo has its own database, starts with dispatch paused, and clearly labels its illustrative plans/results. Enable dispatch to try the complete approval workflow. Stop the current server before switching between demo and real modes.

For a built local app:

```sh
pnpm run build
pnpm start
```

Open **http://127.0.0.1:4310**. Development runs React on 5173 and Hono on 4310; the frontend proxies `/api` to Hono. Production serves both from Hono. This version is a local browser app; desktop packaging is not included.

## The workflow

1. Create a task yourself or ask the chief of staff to create and prioritize work.
2. The dispatcher selects eligible Todo tasks by priority, then creation time, up to the configured system limit. The chief consumes one slot too.
3. Muon creates an isolated Git worktree. The selected agent inspects the code with read-only planning permissions and returns an RFC.
4. The task pauses in **In review** and releases its agent slot. **Attention** points you to the RFC. Discuss the plan with the agent: every comment queues a revised RFC and an answer, retaining the conversation and all earlier versions. Repeat as needed, then approve the exact latest revision.
5. The approved task queues for **Building**, then **Verification**, reusing its worktree and provider session. Muon validates the worktree identity before each phase.
6. Passing verification creates a **Done** task with test steps, final summary, retained output files and screenshots/recordings when provided, and Git-derived changed files. Failures and unrun checks become **Blocked** and appear in Attention; their retained files remain available.

Send a task comment to follow up with its agent. Muon interrupts active work, waits for shutdown, delivers the message in a read-only turn using the same session and worktree, and saves the final reply as a comment before resuming the prior phase. Questions on Done or Blocked tasks preserve their state and evidence. Request a new RFC for changed scope; it still needs owner approval before implementation. Comments and delivery failures remain saved for retry. Unstarted-task comments become planning context; canceled tasks and groups do not accept follow-ups.

Reading an approval does not resolve it. Completion notifications can be acknowledged. When every task is Done or Canceled and at least one is verified, Attention also reports project completion with the canceled count. Adding new work clears that project completion notice. Done means verification passed; Muon keeps the branch/worktree for your review and does not merge, push, or deploy it.

Choose **Task group** for an organizational parent: it never launches an agent and completes when its nonempty set of children and dependencies are Done. Nested groups are supported. Adding new work reopens a completed group. A canceled child remains visible and prevents successful group completion until you explicitly remove it from the group or cancel the group.

Coding subtasks have independent RFCs, worktrees, and verification. They run independently unless dependencies connect them. A coding parent waits for children, then runs its own approved integration workflow. Muon exports completed dependency changes into immutable patches attached to the integration RFC, including uncommitted and untracked files. The Plan tab shows these inputs and downloads the exact patches; building uses the snapshots you reviewed. Completion does not merge sibling branches automatically. A canceled dependency or child does not unblock parent coding work until you resolve its scope.

The chief creates groups and coding tasks, edits unstarted metadata and relations, queues, prioritizes, cancels, recovers failures, and summarizes results by running the Muon CLI. Every CLI operation goes through the same REST API and task service as the UI. The final reply is display-only. Short-lived scoped credentials cannot approve RFCs, submit owner reviews, mark coding work verified, change settings, or clear attention.

Chief task descriptions capture the goal in 1-3 short sentences for simple requests, preserving explicit requirements and references. Detailed design and verification plans belong in the task's RFC. Simple task changes receive a brief confirmation; ask for more detail when needed.

Blocked tasks offer **Retry**, **Fix implementation**, and **Request new RFC**. Retry repeats the failed phase. Fix returns an approved build or verification failure to building, then verifies again. A new RFC revokes the old approval and pauses for your new decision. Each attempt retains its evidence, and the Evidence tab distinguishes the latest attempt from earlier failures.

## Assets

An **Asset** is a retained file: a user upload, an imported file, or an agent output. The same model represents inputs and outputs, with its own owner and visibility. Reference it directly in text as `[Report](asset://ASSET-ID)` or `![Screenshot](asset://ASSET-ID)`. Descriptions, comments, plans, and results can refer to the same file without a separate `TaskAsset` model or task relationship fields. A reference does not grant permission to read the file.

Use **Add file** in the **Assets** tab before planning starts so the RFC can account for the file. Muon adds a reference to the task description and supplies a readable copy in the task's own worktree. **Referenced files** resolves the task's text references and previews Markdown reports with tables and a heading outline, raster images, video/audio, and text or code. Click a Markdown asset link to open its preview. Other file types remain downloadable. The **Changes** tab offers **Open as asset** for listed changed files from a stopped task, retaining the file and adding a reference to its result without rerunning the agent or changing its verification outcome.

Files can be up to 100 MiB. Text previews are limited to 2 MiB; **Download** always preserves the complete original. HTML and SVG appear as source, and Markdown does not execute embedded HTML or load remote images.

Asset metadata lives in SQLite and file bytes live in managed local storage, independent of the source worktree. New assets are private to their owner; project visibility permits access within the asset's project. The storage boundary records a backend ID and object key so a future GCS implementation can provide the same contract; GCS is not configured or shipped yet. Existing evidence attachments and legacy download URLs remain supported.

## REST API and CLI

The HTTP service is the system of record. The web panel, owner CLI, and local chief all use it; clients never open SQLite. A future cloud chief can call the same REST resources directly.

```sh
pnpm run cli tasks list --status todo
pnpm run cli tasks create --json '{"title":"Review API design","status":"backlog"}'
pnpm run cli tasks get MUO-1
pnpm run cli tasks plans MUO-1
pnpm run cli attention list --unread
```

`node /absolute/path/to/muon/bin/muon.mjs` works from any directory, and the package exposes a `muon` bin. Set `MUON_API_URL` to the service origin; the local default is `http://127.0.0.1:4310`. The server must be running. Commands return JSON, use nonzero exit codes for errors, and accept JSON or a body file/stdin. RFC/evidence/patch downloads preserve original bytes.

See the [REST resource contract](docs/rest-api.md) and [CLI reference](docs/cli.md). The current owner boundary trusts this computer's loopback interface. Remote authentication, membership, and deployment policy remain future implementations.

## Local data and recovery

By default data lives in `.muon/local/` (demo: `.muon/demo/`):

- `muon.sqlite`: scoped projects, settings, tasks, assets, run history, RFC decisions and review conversations, evidence metadata, attention, and final chief messages. SQLite uses WAL and optimistic task revisions.
- `worktrees/`: persistent worktree manifests and checkouts, namespaced by repository identity and task ID.
- `assets/`: retained input and output bytes, addressed through asset records.
- `artifacts/`: earlier evidence attachments, preserved for legacy downloads and migration to assets.
- `server.lock`: prevents multiple dispatchers opening the same data directory.

Normal shutdown stops agents and releases the local instance lock. On restart, interrupted tasks become Blocked, keep their worktrees, and pause automatic dispatch; they are never assumed successful. After a hard crash, inspect and stop any surviving agent processes before resuming dispatch or retrying a task. Muon cannot prove orphan process exit across a killed server. If an agent cannot confirm shutdown in a running server, its capacity slot stays reserved.

Worktrees start from the repository's committed `HEAD`; uncommitted main-checkout changes, ignored dependencies, secrets, and local setup files are not copied. Agents plan necessary setup, then install dependencies within their own checkout after RFC approval. Sandbox/permission failures are surfaced in the task. Worktrees are retained and there is no automatic cleanup or merge action. Dependency patches are bounded to 256 KiB each and 512 KiB combined; larger integrations stop with an explanation instead of receiving incomplete code.

## Configuration

Choose the quick planning chat's model from the dropdown in its message toolbar. It offers the configured default, `opus`, `sonnet`, `haiku`, and **Enter model ID…** for another Claude model. Selections save immediately for that disposable chat and survive page reloads while the server is running. After a usage-limit error, choose another available model and send a follow-up to continue with the same conversation. Wait for an active reply to finish before switching. The **(default)** option restores `MUON_CLAUDE_MODEL`.

Planning chats use a compact toolbar for navigation and **Taskify**, leaving the rest of the view for the conversation. Chats are temporary and disappear when discarded or when the server restarts. If an old chat is no longer available, choose **Start new chat** on that screen or **Create task** in the sidebar to open a fresh conversation.

Chief, planning chats, task Comments, and RFC discussions share the same scrolling behavior. Sending reveals your message; incoming replies follow only while you are at the latest messages. Reading older messages keeps your place and shows a compact new-message control and **Jump to latest**. Switching conversations or task tabs restores your place while the app page remains open. On narrow screens, the Plan tab switches between **RFC** and **Discussion**, keeping the reply box visible. Reloading clears reading positions; it does not change the underlying conversation's persistence.

Choose the chief of staff's model directly from the dropdown in its message toolbar; selections save immediately. The menu includes the configured default, `opus`, `sonnet`, and `haiku`. **Enter model ID…** opens an inline field for another model available to your Claude Code account; Enter saves and Escape cancels. The selection is saved for this project and applies only to chief requests. Select the **(default)** option to return to `MUON_CLAUDE_MODEL`; thinking effort continues to use `MUON_CLAUDE_EFFORT`. Wait until the chief finishes before changing its model.

Choose **Configure SOUL** in the Chief composer to edit the Chief's per-project persona and working style. The editor supports Markdown, shows a live preview, and saves the SOUL for future Chief requests. Keep permissions, RFC approvals, and other safety rules out of the SOUL; those system rules always remain in force. Changes are blocked while a Chief request is queued or running.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MUON_DATA_DIR` | `.muon` | Parent directory for local/demo state |
| `MUON_REPOSITORY_PATH` | empty | Initial repository path; existing settings take precedence |
| `MUON_CLAUDE_EXECUTABLE` | `claude` | Claude Code executable |
| `MUON_CLAUDE_MODEL` | `claude-fable-5-1[1m]` | Claude Code model |
| `MUON_CLAUDE_EFFORT` | `max` | Claude Code thinking effort |
| `MUON_CLAUDE_ALLOWED_DOMAINS` | `registry.npmjs.org` | Legacy allowlist used when agent permission bypass is disabled |
| `MUON_AGENT_BYPASS_PERMISSIONS` | enabled | Set to `0` to retain provider sandbox and approval restrictions; enabled runs Claude with `--dangerously-skip-permissions` and Codex with `danger-full-access` |
| `MUON_CLAUDE_ALLOW_LOCAL_SERVERS` | unset | Set to `1` when approved Claude tasks need to start a local preview/test server |
| `MUON_CODEX_EXECUTABLE` | project-managed Codex CLI | Optional override for a specific Codex executable |
| `MUON_CODEX_MODEL` | `gpt-6-astra` | Codex model |
| `MUON_CODEX_REASONING_EFFORT` | `ultra` | Codex reasoning effort |
| `MUON_DEMO` | unset | Set to `1` for the isolated demo |
| `PORT` | `4310` | Hono port; update the Vite proxy if changing it during development |

The app binds to loopback and rejects foreign hosts/origins. It has a fixed local owner, not a network authentication system. Do not expose this local server publicly.

By default, Muon launches coding, planning, chat, and verification agents with the owner's full local permissions: Claude uses `--dangerously-skip-permissions`, and Codex uses `approvalPolicy: never` with `danger-full-access`. Set `MUON_AGENT_BYPASS_PERMISSIONS=0` to restore the restricted provider policies. The chief remains scoped to its Muon CLI so it cannot mutate tasks outside the server's owner boundary. Full access lets agents read or write outside isolated worktrees and use unrestricted network access; enable it only when that is your intended local policy.

## Architecture and validation

TypeScript, React, Tailwind CSS 4, shadcn-style Radix primitives, Hono, and Node's SQLite driver. Provider processes, worktrees, persistence, identity, asset storage, and dispatch have explicit contracts. The UI supports one project and one owner; stored IDs and repository scopes reserve the path to collaboration.

- [Linear product study and adapted PRD](docs/linear-product-study.md)
- [Implementation architecture and cloud boundaries](docs/architecture.md)
- [Orca adapter provenance and runtime decisions](docs/agent-runtime.md)
- [Acceptance against all 13 requirements](docs/requirements-acceptance.md)
- [Actual Codex workflow validation](docs/codex-live-validation.md)
- [Actual Claude validation](docs/claude-live-validation.md)
- [Browser workflow and media validation](docs/browser-validation.md)
- [Conversation scrolling behavior and validation](docs/conversation-scroll-validation.md)

```sh
pnpm run typecheck
pnpm test
pnpm run build
```

Tests use actual temporary SQLite databases and Git repositories plus controlled provider executables. They cover approval races, dispatch capacity, dependencies, group rollups, chief mutations, recovery, cancellation, restart recovery, provider framing, artifact containment, recording byte ranges, and HTTP validation. They do not spend model credits. Separate opt-in live validation scripts exercise the real authenticated providers in isolated repositories and independently rerun their tests; see the linked acceptance records.

`pnpm run test:browser` runs the complete browser acceptance with controlled agents, actual SQLite/Git worktrees, and recorded media. Install its dedicated Chromium runtime once with `pnpm exec playwright install chromium` if it is not already present. `pnpm run test:live:claude`, `pnpm run test:live:codex`, `pnpm run test:live:chief`, and `pnpm run test:live:dependencies` use your authenticated provider accounts and make real model calls.

`pnpm run test:browser:scroll` checks conversation scrolling in desktop and mobile Chromium with controlled agents and isolated data, including send timing, reading anchors, unread navigation, media resizing, and position restoration.
