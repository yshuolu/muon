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
muon tasks list --workflow research
muon tasks list --parent MUO-1
muon tasks list --parent null
muon tasks list --blocked-by MUO-2 --search "authentication"
muon tasks get MUO-3
muon tasks create --json '{"title":"Authentication","kind":"group","status":"backlog"}'
muon tasks create --json '{"title":"Implement sign in","parentId":"MUO-1","status":"todo"}'
muon tasks create --workflow brainstorm --json '{"title":"Explore sign-in options"}'
muon tasks create --workflow research --json '{"title":"Compare identity providers"}'
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
muon tasks subtasks MUO-1
muon tasks dependencies MUO-3

muon attention list --unread
muon attention read ATTENTION-ID
muon chief messages
muon chief send --json '{"content":"Break authentication into reviewed coding tasks."}'
```

Task references accept UUIDs or project identifiers. `tasks MUO-3 evidence` and `tasks MUO-3 discussion` are also accepted for task subresources. Creation and edits use the API’s validated JSON fields; protected lifecycle state and RFC ownership cannot be overridden by JSON or by using the generic API command. Exact plan IDs are mandatory for approvals and review comments so a stale decision cannot approve or revise a later RFC.

## Selecting a workflow

`tasks create --workflow brainstorm|research|develop` adds a workflow to the JSON or file body. Specify it either in the body or as a flag; supplying both is rejected. Develop is the default. Brainstorm and Research each produce a final task result without requiring a Git repository, RFC review, building, or code verification. Develop uses Plan, owner approval, Build, and Verify. Task groups remain organizational containers and cannot select workflows. Workflow selection cannot be changed with `tasks update`.

The owner can reuse an exact approved RFC through Develop's JSON parameters:

```sh
muon tasks create --json '{"title":"Implement sign in","description":"The exact approved description","blockedByIds":[],"workflow":{"kind":"develop","params":{"approvedPlan":{"taskId":"MUO-3","planId":"EXACT-APPROVED-PLAN-ID"}}}}'
```

The source must be owned by the same owner in this project, have no children, and have a current RFC approved by that owner. Copy its exact title, description, and dependency set into the new task. Muon retains the approved plan, frozen dependency snapshots, and base commit, then queues Build. A stale reference or changed scope is rejected, and the chief cannot import approvals. To change scope, create a normal Develop task and review its new RFC.

## Discussing an RFC

The owner can post a comment on a pending RFC with `tasks comment`. The server persists the comment and queues the planning agent to reply and produce a revised RFC. Read `tasks discussion` for the conversation and `tasks plans` for the new pending plan ID. Continue commenting on each latest revision until it is ready, then run `tasks approve` with that exact ID. The owner must wait for the current revision to finish before posting another comment; stale, mid-revision, or approved plan references return 409.

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

## Plans, dependency patches, and evidence files

```sh
muon tasks plan MUO-3 EXACT-PLAN-ID --output rfc.md
muon tasks dependency-patch MUO-3 EXACT-PLAN-ID MUO-2 --output dependency.patch
muon artifacts download ARTIFACT-ID --output verification.webm
```

Plan exports preserve their original Markdown or HTML. Dependency exports download the exact immutable patch recorded with the RFC. Artifact downloads preserve binary bytes. An output path must be new and its parent directory must exist; downloads never overwrite existing files. `--output -` writes raw bytes to stdout for piping, without JSON framing. After file downloads, stdout contains the path, byte length, and content type.

## Generic REST access

All public REST routes remain reachable through the CLI even before they gain dedicated aliases:

```sh
muon api GET /api/tasks/MUO-3/evidence
muon api PATCH /api/tasks/MUO-3 --file edits.json
muon api GET /api/artifacts/ARTIFACT-ID --output screenshot.png
```

Generic paths must stay within `/api/` on the configured origin. Bearer credentials, permissions, validation, conflicts, and owner approval checks behave exactly as they do for named commands. The shared `ApiClient` is transport-only and also works in the browser with a same-origin `/api` base.

Read a task’s logical sessions with `muon tasks sessions MUO-12` and its saved ideas or reports with `muon tasks outputs MUO-12`. `tasks runs` retains per-attempt history.
