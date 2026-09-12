# Muon CLI

Muon’s CLI is a thin client of its REST API. The web panel, CLI, and future cloud agents share the same task records and domain rules. It never opens SQLite, imports the task service, or falls back to local database writes when HTTP is unavailable.

Launch the normal local user app with `pnpm run user`. It starts the real API and web app together at `http://127.0.0.1:5173`. For development, `pnpm run dev` is an equivalent alias; `pnpm start` serves the built app from Hono at `http://127.0.0.1:4310`. From this checkout, use `./bin/muon.mjs` or `pnpm --silent run cli`. The absolute launcher works from another repository or worktree without changing its current directory:

```sh
node /absolute/path/to/muon/bin/muon.mjs tasks list --status todo
```

The executable is also declared as the package’s `muon` bin. Dependencies must be installed in the Muon checkout; the launcher resolves its own TypeScript runtime rather than using a global installation. All examples below use `muon` as shorthand for this launcher.

`MUON_API_URL` selects the API origin and defaults to `http://127.0.0.1:4310`. It may be an HTTP(S) origin with an optional `/api` suffix. `MUON_API_TOKEN` supplies an optional bearer credential exclusively through the environment. Tokens are never accepted as command arguments, and HTTP redirects are rejected so credentials cannot follow a redirect to another service. The local chief receives its own restricted capability from the server; owner-only review remains enforced by the API. Selecting a remote origin does not itself implement cloud authentication or multiuser support.

## Records and operations

```sh
muon health
muon state
muon project
muon runtime
muon settings get
muon settings update --json '{"maxConcurrentAgents":2,"dispatcherEnabled":true}'

muon tasks list --status todo --provider claude
muon tasks list --parent MUO-1
muon tasks list --parent null
muon tasks list --blocked-by MUO-2 --search "authentication"
muon tasks get MUO-3
muon tasks create --json '{"title":"Authentication","kind":"group","status":"backlog"}'
muon tasks create --json '{"title":"Implement sign in","parentId":"MUO-1","status":"todo"}'
muon tasks update MUO-3 --json '{"priority":1,"blockedByIds":["MUO-2"]}'
muon tasks cancel MUO-3
muon tasks retry MUO-3 --mode fix --feedback "Fix the failing password reset check."

muon tasks plans MUO-3
muon tasks plan MUO-3 EXACT-PLAN-ID
muon tasks discussion MUO-3
muon tasks comment MUO-3 --plan-id EXACT-PLAN-ID --content "Include accessibility checks."
muon tasks approve MUO-3 --plan-id EXACT-PLAN-ID
muon tasks evidence MUO-3
muon tasks files MUO-3
muon tasks activity MUO-3
muon tasks runs MUO-3
muon tasks comments MUO-3
muon tasks comment MUO-3 --json '{"requestId":"1c1ddc66-3593-414e-b11b-95c6b9216b31","content":"Explain the verification result."}'
muon tasks retry-comments MUO-3
muon tasks subtasks MUO-1
muon tasks dependencies MUO-3

muon attention list --unread
muon attention read ATTENTION-ID
muon chief messages
muon chief send --json '{"content":"Break authentication into reviewed coding tasks."}'
```

Task references accept UUIDs or project identifiers. `tasks MUO-3 evidence`, `tasks MUO-3 discussion`, and `tasks MUO-3 comments` are also accepted for task subresources. Creation and edits use the API’s validated JSON fields; protected lifecycle state and RFC ownership cannot be overridden by JSON or by using the generic API command. Exact plan IDs are mandatory for approvals and RFC review comments so a stale decision cannot approve or revise a later RFC.

## Following up with the task agent

Use `tasks comment` without a plan ID to send a general follow-up. An active agent is interrupted, its shutdown is confirmed, and a read-only reply runs in the retained session and worktree. The reply is saved in `tasks comments`, then interrupted work resumes under its existing RFC approval. Questions on Done or Blocked tasks preserve their state and evidence. Comments on unstarted tasks become planning context; canceled tasks and task groups do not accept follow-ups.

Each submission requires a new UUID `requestId`. Keep that same ID, content, and mode if retrying an uncertain HTTP response so the comment is not duplicated. Use `mode: "replan"` when changing scope; the task returns to planning and requires fresh RFC approval. To retry a saved comment whose delivery failed, use `tasks retry-comments` instead of creating another comment.

```sh
muon tasks comment MUO-3 --file follow-up.json
muon tasks comment MUO-3 --request-id 1c1ddc66-3593-414e-b11b-95c6b9216b31 --content "Also support keyboard navigation." --mode replan
muon tasks comments MUO-3
muon tasks retry-comments MUO-3
```

Bodies accept `content` (1–20,000 nonblank characters), `requestId`, and optional `mode` (`message`, the default, or `replan`). Posting and retrying follow-ups require the owner; chief credentials permit reads only. Delivery waits while dispatch is paused or all agent slots are occupied.

## Discussing an RFC

The owner can post a comment on a pending RFC with `tasks comment --plan-id ...` or a body containing `planId`. This existing form remains compatible and uses the RFC discussion resource. The server persists the comment and queues the planning agent to reply and produce a revised RFC. Read `tasks discussion` for the conversation and `tasks plans` for the new pending plan ID. Continue commenting on each latest revision until it is ready, then run `tasks approve` with that exact ID. The owner must wait for the current revision to finish before posting another comment; stale, mid-revision, or approved plan references return 409.

Comments accept up to 20,000 nonblank characters. Previous comments, final agent replies, and RFC revisions remain in the task. The chief may read the discussion, but its credential cannot post owner comments or approve plans. For longer comments use a JSON file:

```sh
muon tasks comment MUO-3 --json '{"planId":"EXACT-PLAN-ID","content":"Please include rollback and accessibility checks."}'
muon tasks comment MUO-3 --file review-comment.json
muon tasks discussion MUO-3
```

`tasks request-changes MUO-3 --plan-id EXACT-PLAN-ID --feedback "..."` remains available for compatibility and posts to the same discussion. The conversational `tasks comment` command is preferred for new clients.

## JSON input and output

Every body-taking command accepts one of `--json '{...}'`, `--file request.json`, or `--file -` to read standard input. File paths are relative to the caller’s current directory. For longer or untrusted text, a JSON file or standard input avoids shell quoting mistakes.

```sh
muon tasks create --file new-task.json
muon tasks update MUO-3 --file - < edits.json
```

Successful record commands emit one JSON value to stdout. Errors emit one `{ "error": { "code", "message", "status" } }` value to stderr and exit with status 1. HTTP failures preserve the API status and code; local argument and connectivity failures use status 0. Help is ordinary text. No model logs, npm banners, or SQLite output are mixed into command results when using the launcher directly.

## Plans, dependency patches, and asset files

```sh
muon tasks plan MUO-3 EXACT-PLAN-ID --output rfc.md
muon tasks dependency-patch MUO-3 EXACT-PLAN-ID MUO-2 --output dependency.patch
muon api GET /api/tasks/MUO-3/assets
muon api GET /api/assets/ASSET-ID
muon api GET /api/assets/ASSET-ID/content --output report.md
muon artifacts download ARTIFACT-ID --output verification.webm
```

Plan exports preserve their original Markdown or HTML. Dependency exports download the exact immutable patch recorded with the RFC. Asset downloads preserve binary bytes. `artifacts download` remains available for legacy evidence URLs; new records use `/api/assets/:id/content`. An output path must be new and its parent directory must exist; downloads never overwrite existing files. `--output -` writes raw bytes to stdout for piping, without JSON framing. After file downloads, stdout contains the path, byte length, and content type.

Add a reference to an existing asset in an unstarted task description or retain a listed changed file from a stopped task through the JSON API:

```sh
muon api POST /api/tasks/MUO-3/assets/attach --json '{"assetId":"ASSET-ID"}'
muon api POST /api/tasks/MUO-2/assets/import --json '{"path":"report.md"}'
```

These operations require the owner. Adding a reference through `assets/attach` is allowed only before planning begins. Uploading a new file uses multipart HTTP through the UI or `curl -F 'file=@brief.md' http://127.0.0.1:4310/api/tasks/MUO-3/assets`; the CLI's `--file` option reads a JSON request body and is not a binary upload option. A file is referenced in text as `[Report](asset://ASSET-ID)` or `![Screenshot](asset://ASSET-ID)`. References do not change asset ownership or visibility.

## Generic REST access

All public REST routes remain reachable through the CLI even before they gain dedicated aliases:

```sh
muon api GET /api/tasks/MUO-3/evidence
muon api PATCH /api/tasks/MUO-3 --file edits.json
muon api GET /api/assets/ASSET-ID/content --output screenshot.png
```

Generic paths must stay within `/api/` on the configured origin. Bearer credentials, permissions, validation, conflicts, and owner approval checks behave exactly as they do for named commands. The shared `ApiClient` is transport-only and also works in the browser with a same-origin `/api` base.
