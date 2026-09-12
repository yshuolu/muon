# Muon record API

Muon’s HTTP service owns the project’s task records, assets, workflow transitions, plans, evidence, attention, and chief messages. The web interface and CLI are clients of this API. A future cloud chief can use the same resources directly; it does not need SQLite access or an in-process `TaskService` reference.

The local base URL is `http://127.0.0.1:4310/api`. The development web server proxies `/api` to it. Requests and responses use JSON, except file uploads and asset, legacy artifact, and dependency-patch downloads. Mutations require `Content-Type: application/json`, including an empty `{}` body where specified; the two asset upload routes require `multipart/form-data` with exactly one `file` field. JSON request bodies are limited to 1 MiB. File uploads are limited to 100 MiB, with a 101 MiB request limit allowing for multipart framing. Successful reads receive `Cache-Control: no-store`.

Shared request validation and TypeScript input types live in [`src/shared/api-contract.ts`](../src/shared/api-contract.ts). Response records are the public application interfaces in [`src/shared/types.ts`](../src/shared/types.ts). Collections are JSON arrays; individual resources are JSON objects. There is no `data` wrapper. Existing `/api/state` and mutation routes remain compatible with the browser client.

## Identity and access

Every route uses the service’s configured `workspaceId`, `projectId`, and owner scope. The caller cannot select another project or user using request bodies, headers, or query parameters. Task ownership and identifiers are immutable. Records from another scope return 404 and cannot be used as parent/dependency references.

The local HTTP boundary validates the Host and Origin headers, accepts local hosts only, and checks each mutation's content type. The `HttpRequestAccess` interface adds request authorization and optional observation of successful responses. The runtime provides temporary bearer credentials to chief CLI sessions. This allows the server to distinguish the chief from the local owner and reject owner-only actions; a future hosted deployment can provide an authenticated access implementation and scoped services at this boundary. This is not a cloud identity or multi-user implementation.

Access adapters implement `authorize(request)` before a route executes and may implement `observe(request, response)` after a successful response. Throw `DomainError` with 401 or 403 to reject access. Adapters that inspect JSON bodies must read a clone so the handler and client retain their original streams. Failed responses are not observed. The default option remains compatible with the existing trusted local owner surface when no adapter is supplied.

The chief may manage task records through its authorized CLI calls. It cannot approve its own RFC, change owner settings, or start another chief request. Approval remains an explicit owner operation, validated by the server against the current pending RFC. Unknown or expired bearer credentials are not a fallback to owner authority.

## Reads

| Method and path | Response |
| --- | --- |
| `GET /health` | `{ "ok": true }` |
| `GET /state` | `AppSnapshot` with scope, project, settings, tasks, attention, chief messages, runtime |
| `GET /project` | `Project`, including configured repository path |
| `GET /settings` | `Settings`: concurrency, dispatcher state, default provider, optional chief model override and SOUL |
| `GET /runtime` | `AppSnapshot["runtime"]`: active count, chief state, provider availability, demo flag |
| `GET /tasks` | `Task[]`, optionally filtered as below |
| `GET /tasks/:task` | `Task` |
| `GET /tasks/:task/plans` | `Plan[]`, including historical RFCs and frozen dependency inputs |
| `GET /tasks/:task/plans/:planId` | `Plan` belonging to this task |
| `GET /tasks/:task/plan-discussion` | `PlanDiscussionMessage[]`, owner comments and final agent replies across RFC revisions |
| `GET /tasks/:task/evidence` | `Evidence[]`, including history and `runId` associations |
| `GET /tasks/:task/assets` | Authorized `Asset[]` derived from the task's text references |
| `GET /tasks/:task/files` | `ChangedFile[]` |
| `GET /tasks/:task/activity` | `Activity[]` with concise record change descriptions |
| `GET /tasks/:task/runs` | `AgentRun[]` with phase, timestamps, outcome, and RFC association |
| `GET /tasks/:task/subtasks` | Direct child `Task[]`; use each child’s resource to traverse deeper |
| `GET /tasks/:task/dependencies` | Direct prerequisite `Task[]`, in the task’s `blockedByIds` order |
| `GET /attention` | `Attention[]`; `?unread=true` returns unread records, `?unread=false` returns read records |
| `GET /chief/messages` | `ChiefMessage[]`, persisted user messages and final chief results |
| `GET /assets/:assetId` | Scoped `Asset` metadata |
| `GET /assets/:assetId/content` | Original asset bytes; `?download=1` requests an attachment download |
| `GET /artifacts/:artifactId` | Legacy scoped evidence bytes, with stored MIME type |
| `GET /tasks/:task/plans/:planId/dependencies/:dependency/patch` | Exact bytes of the dependency snapshot frozen into that RFC |

`:task` accepts a canonical task UUID or its human-readable identifier, such as `MUO-12`. Identifier matching is case-insensitive. Responses always use canonical UUIDs in `id`, `parentId`, `blockedByIds`, and linked record fields. Plan, asset, and legacy artifact IDs are exact IDs; a plan must belong to the task in the URL. The patch route’s `:dependency` accepts the frozen input’s `taskId` or identifier and reads the stored snapshot, even if the source worktree subsequently changes.

Task-list filters can be combined with AND semantics:

| Query parameter | Meaning |
| --- | --- |
| `status` | One of `backlog`, `todo`, `in_progress`, `in_review`, `done`, `blocked`, `canceled` |
| `parentId` | UUID/identifier of the direct parent; the literal string `null` selects top-level tasks |
| `blockedById` | UUID/identifier of a direct prerequisite |
| `provider` | `claude` or `codex` |
| `kind` | `coding` or `group`; older records without a kind count as coding |
| `search` | Case-insensitive substring in identifier, title, description, or any label; maximum 1,000 characters |

Omitted filters impose no constraint. Each parameter accepts one value. Unrecognized query parameters and invalid enum values return 400; a parent or blocker reference outside the scoped task collection returns 404. Task collections preserve repository insertion order. Plans, runs, activity, and chief messages preserve their stored history order. There is no pagination in the local implementation.

No endpoint returns model reasoning or tool-call transcripts. Run records expose operational metadata, and evidence exposes final test outcomes, steps, and attached artifacts. Evidence is not filtered to only the latest attempt; clients can group it by `runId` without discarding prior results.

Asset and legacy artifact downloads support a single HTTP byte range, including open-ended and suffix ranges. Valid range requests return 206 with `Content-Range`; invalid or unsatisfiable ranges return 416. Downloads have restrictive CSP and `nosniff` headers. Dependency patches use `application/octet-stream` and a safe attachment filename; UTF-8 and base64-backed snapshots are decoded to their exact original bytes.

An `Asset` contains `id`, `workspaceId`, `projectId`, `ownerUserId`, `visibility` (`private` or `project`), `name`, `mediaType`, `sizeBytes`, `sha256`, `storageBackendId`, `objectKey`, `origin` (`upload`, `generated`, or `imported`), `createdAt`, and `createdByUserId`; imported files may also record their relative `sourcePath`. New assets are private. Private assets are readable only by their owner; project-visible assets remain constrained to their workspace/project. A reference never grants access, and unavailable references do not reveal private metadata. Visibility changes and recipient-specific sharing do not yet have public mutation routes.

Use Markdown references directly in descriptions, comments, plans, results, or evidence text: `[Report](asset://ASSET-ID)` or `![Screenshot](asset://ASSET-ID)`. There are no task asset-ID arrays, task foreign keys, or input/output roles on the asset model. A file can be referenced from multiple places without copying its database record. Read `/tasks/:task/assets` for a deduplicated, authorized view derived from the task's text. Older evidence may still contain legacy `artifactUrl` values. Storage paths are not public asset references.

## Mutations

| Method and path | Body | Success response |
| --- | --- | --- |
| `POST /tasks` | `CreateTaskRequest` | 201 `Task` |
| `PATCH /tasks/:task` | `EditTaskRequest` | 200 `Task` |
| `POST /assets` | Multipart `file` | 201 standalone `Asset` |
| `POST /tasks/:task/assets` | Multipart `file` | 201 `Asset`, with a reference appended to the task description |
| `POST /tasks/:task/assets/attach` | `{ "assetId": "…" }` | 200 existing `Asset`, with a reference appended to the task description |
| `POST /tasks/:task/assets/import` | `{ "path": "report.md" }` | 201 retained `Asset`, with a reference appended to the task result and a retained evidence note |
| `POST /tasks/:task/cancel` | `{}` | 200 canceled `Task` |
| `POST /tasks/:task/approve` | `{ "planId": "…" }` | 200 `Task` with owner-approved plan queued for building |
| `POST /tasks/:task/plan-discussion` | `{ "planId": "…", "content": "…" }` | 200 `Task` with the owner comment persisted and revised planning queued |
| `POST /tasks/:task/request-changes` | `{ "planId": "…", "feedback": "…" }` | 200 `Task`; compatibility alias that posts feedback to the RFC discussion |
| `POST /tasks/:task/retry` | `{ "mode"?: "retry" \| "fix" \| "replan", "feedback"?: "…" }` | 200 `Task` |
| `POST /attention/:attentionId/read` | `{}` | 200 `{ "ok": true }` |
| `POST /chief/messages` | `{ "content": "…" }` | 202 persisted user `ChiefMessage` |
| `POST /planning-chats` | `{}` | 201 disposable read-only planning chat |
| `GET /planning-chats/:id` |  | Current planning chat messages and activity |
| `POST /planning-chats/:id/messages` | `{ "content": "…" }` | 202 queued read-only planning reply |
| `POST /planning-chats/:id/taskify` | `CreateTaskRequest` | 201 creates a normal task with the chat transcript in its description |
| `DELETE /planning-chats/:id` | `{}` | 200 discards the chat and aborts an active reply |
| `PATCH /settings` | `UpdateSettingsRequest` | 200 `{ "ok": true }`; read `/settings` and `/project` for updated records |

Task creation requires a nonempty title (maximum 240 characters). Optional fields are description (30,000 characters), provider, priority (0–4), status (`backlog` or `todo`), labels (up to 20 strings, 40 characters each), parentId (nullable), blockedByIds (up to 100 references), and kind (`coding` or `group`). The server supplies scope, owner, stable ID, sequence identifier, timestamps, and initial workflow fields. Both relation fields accept UUIDs or identifiers and are resolved inside the current project. Labels are normalized by the service.

Task editing permits those same descriptive, priority, provider, label, and relation fields, but cannot change `kind`; its permitted statuses are `backlog`, `todo`, and `canceled`. The service restricts which records are still editable and rejects relation cycles. To remove a parent use `"parentId": null`; to remove all dependencies use `"blockedByIds": []`. Omitted fields are unchanged. Active workflow state, plans, evidence, runs, ownership, and completed outcomes cannot be set through a generic patch. They are written by the server's domain operations.

Asset uploads, task reference insertion, and retained-output imports require the owner; chief credentials cannot perform them. Uploading or inserting a reference through the task assets endpoint requires an idle, unstarted task. Use a Backlog task when adding files to avoid racing automatic planning. Planning resolves description references and includes them in the RFC text for review; approved execution uses its references. The input set is limited to 100 files and 100 MiB combined. Inserting an existing asset reference reuses its metadata and retained bytes. Output import requires a stopped task and an exact nondeleted changed-file path in its validated worktree; absolute paths, traversal, and symlink escapes are rejected. It does not rerun the provider or modify verification results. Arbitrary file types can be stored up to 100 MiB; UI preview support is separate from storage support.

Approval and discussion comments must include the exact current pending `planId`. A stale, already-approved, canceled, or currently revising RFC returns 409. Discussion comments require nonblank content of at most 20,000 characters; content is trimmed before storage. The server records the owner identity, closes that pending RFC for review, and queues the planning agent to respond and revise it. Poll the discussion and plans resources for the final reply and new pending RFC. Repeat this comment–revision conversation until the owner approves the latest exact plan ID. Each message has `id`, `role` (`user` or `assistant`), `content`, `createdAt`, and `planId`; owner comments also record `userId`. Agent replies link to the newly produced RFC. Older comments and RFCs remain available after approval. Reads return an empty array for older tasks with no discussion.

Discussion posts are owner operations; a chief bearer credential may read the conversation but cannot post as the owner. The legacy `request-changes` endpoint remains supported and delegates to the same discussion operation, mapping `feedback` to `content`. New clients should use the conversation resource. Neither comments nor assistant replies approve implementation.

Recovery preserves prior attempts and artifacts: `retry` resumes the failed phase, `fix` returns to building within the approved scope, and `replan` requires a fresh owner review before building. Recovery feedback is optional and limited to 20,000 characters. The service validates whether each operation is appropriate for the task’s current state.

Settings accepts optional `maxConcurrentAgents` (integer 1–8), `dispatcherEnabled` (boolean), `defaultProvider`, `repositoryPath`, `projectName`, `chiefModel`, and `chiefSoul`. The chief model is a trimmed model alias or identifier of 1–200 characters, starting with a letter or digit and containing only letters, digits, `.`, `_`, `:`, `/`, `[`, `]`, or `-`. Set it to `null` to use the configured Claude default. `chiefSoul` is trimmed text up to 20,000 characters; set it to `null` to restore the default behavior. It is included as owner-authored persona and communication context in future Chief prompts, while Muon's permissions and approval rules remain authoritative. Model and SOUL changes return 409 while a chief request is queued or running. Settings writes and chief submission are serialized so an accepted request retains its selected configuration. Model availability is checked by the Claude runtime when it runs. Repository changes require a valid committed Git root and are rejected while they would disrupt current work. Changing project display name does not change its stable project ID or task identifier prefix.

Chief messages accept 1–30,000 nonblank characters. A simultaneous or already-pending chief request returns 409. A 202 response means the request was recorded for dispatch; poll `/chief/messages` and `/runtime` for the final result. Creating a Todo task similarly records it immediately; the dispatcher selects eligible work within the shared concurrency limit.

Planning chats are separate, disposable read-only threads. They are held in memory, excluded from `/state`, the Chief history, and task navigation, and can be addressed through their `/planning-chats/:id` URL while the local server is running. Their provider may inspect the configured repository but cannot edit files or mutate tasks. Taskification is explicit; it copies the conversation into the new task description within the normal 30,000-character description limit, after which the normal RFC approval workflow applies.

## Errors

Errors use `{ "error": "Human-readable description" }`. Relevant status codes are 400 for malformed JSON, unsupported fields, invalid values or domain operations; 401/403 for access rejection; 404 for missing scoped resources; 409 for stale RFCs, concurrent edits, started task inputs, or busy chief state; 413 for oversized bodies; 415 for the wrong mutation content type; and 503 while the service initializes. Unexpected failures return 500 with a generic description. Clients should display the server message and refresh records after conflicts.

## Examples

Create a group and then reference its returned identifier when creating a child. These requests use the trusted local owner surface; an agent session supplies its bearer token through the CLI’s environment instead.

```sh
curl http://127.0.0.1:4310/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"Release preparation","kind":"group","status":"backlog"}'

curl http://127.0.0.1:4310/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"Add release notes","parentId":"MUO-1","status":"todo","provider":"claude"}'

curl 'http://127.0.0.1:4310/api/tasks?parentId=MUO-1&status=in_review'
curl http://127.0.0.1:4310/api/tasks/MUO-2/plans
```

The owner can discuss and revise a pending RFC:

```sh
curl http://127.0.0.1:4310/api/tasks/MUO-2/plan-discussion \
  -H 'Content-Type: application/json' \
  -d '{"planId":"the-current-pending-plan-id","content":"Include keyboard navigation and focus restoration checks."}'

curl http://127.0.0.1:4310/api/tasks/MUO-2/plan-discussion
curl http://127.0.0.1:4310/api/tasks/MUO-2/plans
```

After the agent replies with a revised RFC, the owner can post another comment referencing that revision or approve its exact ID:

```sh
curl http://127.0.0.1:4310/api/tasks/MUO-2/approve \
  -H 'Content-Type: application/json' \
  -d '{"planId":"the-current-pending-plan-id"}'
```

Upload an input to an unstarted task, read its files, or retain an existing report from a stopped task:

```sh
curl http://127.0.0.1:4310/api/tasks/MUO-2/assets -F 'file=@brief.md'
curl http://127.0.0.1:4310/api/tasks/MUO-2/assets
curl http://127.0.0.1:4310/api/tasks/MUO-1/assets/import \
  -H 'Content-Type: application/json' \
  -d '{"path":"report.md"}'
curl 'http://127.0.0.1:4310/api/assets/ASSET-ID/content?download=1' --output report.md
```

The test suite exercises scoped reads, identifier resolution, query combinations, shared input validation, owner workflow gates, authorization before mutations, successful-response observation, historical evidence, asset upload/retention and byte ranges, and exact frozen patch downloads.
