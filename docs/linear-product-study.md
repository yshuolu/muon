# Muon product specification: task management informed by Linear

Research date: September 8, 2026. This document studies Linear's public product documentation, not an internal Linear PRD. The observations below describe published behavior. The Muon requirements that follow are a proposed adaptation for the requested local AI-native IDE; they are not claims about Linear or a statement that every feature is already implemented.

## 1. Product intent

Muon lets an owner describe an outcome to a chief of staff, manage the resulting tasks, approve implementation plans, and inspect verified results. Autonomous work remains understandable through task state, durable decisions, changed files, and evidence. The interface does not require reading an agent's reasoning, tool calls, or execution transcript.

The initial installation serves one owner and one configured repository. Every task belongs to an explicit workspace and project, every human decision has an actor, and runtime resources are represented through replaceable interfaces. Local operation means local orchestration, storage, and agent processes; Claude Code and Codex may still communicate with their configured model services.

## 2. What to take from Linear

### The task is the durable unit of work

Linear requires an issue title and status, assigns a short identifier within its team, and makes other properties optional. Creation is available from a compact composer, full page, shortcuts, and integrations; drafts preserve interrupted composition. [Create issues](https://linear.app/docs/creating-issues)

**Muon decision:** Give every task a stable internal ID and readable identifier such as `MUO-42`. Require a title, project, owner, and state in storage; fill project and owner from the local installation. Keep the composer short: title, description, priority, provider, optional parent. Creating a task in Backlog records an idea; moving it to Todo authorizes automatic planning.

### Separate ownership from agent execution

Linear assigns an issue to one human and supports delegating its work to an agent while preserving human responsibility. Assignment and delegation are separately visible and searchable. [Assign and delegate issues](https://linear.app/docs/assigning-issues)

**Muon decision:** Store `ownerUserId` independently from `agentProvider`. Claude Code and Codex are execution providers, not substitutes for the owner who can approve the RFC. A run belongs to a task and identifies its provider/session. Replacing the provider does not transfer ownership or approval authority.

### Status communicates where work is in its lifecycle

Linear defines ordered, team-specific workflows. Its default is Backlog, Todo, In Progress, Done, and Canceled. Named statuses fit fixed categories; Duplicate is system-managed. Defaults and optional automated closing/archiving are separate settings. [Issue status](https://linear.app/docs/configuring-workflows)

**Muon decision:** Preserve the familiar lifecycle but make planning, review, building, and verification visible. Muon's mandatory RFC gate is a server-enforced transition, not a freely editable label. Status may be displayed consistently in lists, boards, task details, and attention cards. Do not let a general status-edit endpoint skip the gate.

### Hierarchy breaks work down; it does not describe every dependency

Linear supports parent/sub-issues, property inheritance, changing a parent, removing a parent, and views that include or hide children. Children initially inherit team, priority, and project; inheritance is not universal across properties. Optional automation can close a parent after its children, or close children after their parent. A parent can be converted to a project when its scope grows. [Parent and sub-issues](https://linear.app/docs/parent-and-sub-issues)

**Muon decision:** Use the same task entity for parent and child records. Children retain full task detail and their own RFC/results. Inherit project, owner, and priority at creation, with later priority changes independent. Reject self-parenting and ancestry cycles. Show child progress as `3 of 5 done`. Muon should not automatically mark unfinished coding children verified when a parent is closed.

### Dependencies are explicit relations

Linear distinguishes related work, blocking dependencies, and duplicates. Blocking relationships are shown in issue properties; resolved blockers move under related work. Duplicates link to a canonical issue and receive a distinct terminal status. [Issue relations](https://linear.app/docs/issue-relations)

**Muon decision:** Keep dependency edges separate from `parentId`. A parent relationship alone neither serializes all children nor makes one sibling block another. A dependency is an execution constraint. Reject cyclic blocking graphs. Preserve the dependency's historical identity after it is satisfied instead of rewriting history. Cancellation does not count as successful completion of a prerequisite.

### Priority remains small and understandable

Linear offers No priority, Low, Medium, High, and Urgent. It deliberately avoids arbitrary custom priority scales. Ordering supports manual relative position, and unset priority sorts last. [Priority](https://linear.app/docs/priority)

**Muon decision:** Use those five familiar choices. Sort dispatch candidates by urgency, then explicit queue order, then creation time. A task's eligibility is checked before ranking: Urgent cannot bypass an RFC gate or unresolved dependency. Expose the dispatch limit and queue explanation alongside the task list.

### Projects are outcomes, while repositories are execution resources

Linear's conceptual hierarchy distinguishes workspaces, teams, issues, projects, milestones, initiatives, and cycles. Projects organize work around a shared deliverable; cycles are recurring planning periods. Views are lenses on existing work. [Concepts](https://linear.app/docs/conceptual-model)

Linear projects can contain issues and documents, have a clear outcome or completion date, and span multiple teams. They have their own progress and notification features. [Projects](https://linear.app/docs/projects)

**Muon decision:** Do not use a filesystem path as the identity of a project. Store a project record and a repository binding separately, even when the initial UI has one of each. A later release can support multiple repositories per project or several projects in one repository. Defer teams, initiatives, cycles, milestones, and portfolio management; preserve the IDs needed for future scoping.

### Intake and attention solve different problems

Linear Triage is an intake queue for reviewing, clarifying, assigning, and prioritizing incoming issues before they enter the normal workflow. It supports snoozing and excludes triage work from ordinary views unless explicitly included. [Triage](https://linear.app/docs/triage)

Linear Inbox contains notifications for subscribed work, distinguishes Priority from Other, supports read/unread state and snoozing, and opens the referenced work with actions available. [Inbox](https://linear.app/docs/inbox)

Notification subscriptions and delivery channels are separate concerns. Linear can send real-time notifications through several channels and email digests for unread updates. [Notifications](https://linear.app/docs/notifications)

**Muon decision:** Backlog is sufficient for initial intake. Create a dedicated Attention destination for decisions and completed outcomes. An approval request is a durable pending action; reading its card must not approve or dismiss the decision. An informational completion can be acknowledged. Delivery is an adapter so local in-app presentation can later gain desktop or cloud notifications without changing task logic.

### Views reuse the same task data

Linear saves filtered issue/project views, supports favorites and contextual views, and differentiates a view's scope from access permissions. [Custom Views](https://linear.app/docs/custom-views)

Display options control list/board layout, grouping, ordering, visible properties, and the presence of sub-issues or completed work. [Display options](https://linear.app/docs/display-options)

**Muon decision:** All Tasks, Active, Backlog, Completed, and task search are filters over the same records. Begin with a dense list grouped by lifecycle stage. Keep sort/filter state out of task records. A board can be added without creating a second workflow. Show the parent relationship compactly and let users reveal children in place.

### Documents belong with the work

Linear attaches documents to work objects and provides editing, document history, subscriptions, and templates. Its documentation recommends longer documents for complex implementation needs. [Documents](https://linear.app/docs/documents)

**Muon decision:** An RFC is a typed, versioned task artifact with a review record. Verification evidence and changed files receive their own task surfaces. They are not buried in comments or conversation history.

## 3. Muon's initial experience

### Navigation and information hierarchy

Use a persistent sidebar with the project identity at the top, followed by Chief of staff, Attention with a count, and Tasks. Under Tasks, expose All, Active, Backlog, and Completed. Place runtime configuration in Settings: repository, installed providers, capacity, and dispatcher enabled/paused.

Task rows show status, readable identifier, title, priority, provider, and useful small indicators for children or pending attention. The primary task detail contains the title and description, a compact workflow indicator, and tabs for Overview, RFC, Changes, and Verification. The properties panel contains owner, provider, priority, parent, dependencies, and timestamps.

Each empty state should explain the next action. Examples: no queued tasks offers Create task; no RFC says planning has not produced one; no changed files says no changes have been captured yet. Never present placeholder evidence or invented test success as real execution.

### Chief of staff

The chief is an ordinary Claude Code agent session with a chief role and project context. It uses the same provider adapter, session lifecycle, and run/result machinery as coding work. Its distinction is instructions and access to task-management operations.

The owner can ask it to capture work, decompose tasks, set priority, establish dependencies, or summarize results. The visible conversation contains owner messages and final, useful assistant responses with links to affected tasks. An acknowledgement alone is insufficient when an operation was requested: task mutations must be persisted, then summarized.

A chief cannot approve its own or another agent's RFC on the owner's behalf. Moving work into Todo may start planning; the build gate remains an explicit owner action. Discovered work outside an approved task's scope should become a linked backlog task or an RFC revision.

### Task creation and hierarchy

Create task and Add subtask use one composer. Required input is a title; description and properties are progressively available. A subtask inherits the parent's project and owner and initially copies its priority. The parent identifier appears above the child title and is navigable.

Distinguish organizational parents from coding tasks. A container parent coordinates children and does not launch duplicate implementation work. Every child that changes code runs the full coding workflow. If the parent also needs integration work, represent that work explicitly and make it depend on the required child outcomes. Container completion can roll up when all required children are done; a canceled child requires an explicit scope decision rather than a false successful rollup.

For a small initial implementation, one visible level of nesting is acceptable, but the stored parent relation should not require a schema redesign for deeper hierarchy. Changing parents must preserve the task's identifier, run history, and artifacts.

## 4. Mandatory coding workflow

| Product state | Meaning | How it leaves this state |
| --- | --- | --- |
| Backlog | Captured work that is not scheduled | Owner or chief queues it |
| Todo | Eligible work waiting for capacity | Dispatcher claims it |
| Planning | An agent prepares a concrete RFC | Agent submits a complete RFC or reports a problem |
| Plan review | Latest RFC waits for the owner | Owner approves that revision or requests changes |
| Approved / queued for build | Approval is recorded; capacity may be occupied | Dispatcher resumes the task |
| Building | Agent implements the approved RFC | Agent submits implementation output |
| Verifying | Agent checks acceptance criteria and records evidence | Checks pass, implementation needs correction, or a failure needs attention |
| Done | Verified task result and change summary are available | Owner may reopen as new work |
| Blocked / failed | A stated obstacle or execution failure needs resolution | Explicit retry, replan, or cancellation |
| Canceled | Work intentionally stopped | Explicit reopening |

These are product semantics, not a requirement for identical enum names. Approved work can be represented as a queued run whose phase is `building`; the user must still see that approval succeeded and capacity is the reason it has not started. Keep task lifecycle separate from execution attempt state (`queued`, `running`, `succeeded`, `failed`, `canceled`).

### Planning and approval rules

The RFC must state the problem, desired behavior, approach, expected files or components, acceptance criteria, verification plan, and material risks or unresolved choices. Use Markdown initially; support HTML artifacts through an isolated renderer without granting the document scripts access to the application.

Submitting an RFC creates an immutable revision and a pending attention item. The plan review pause releases the runtime slot. Approve binds owner identity, exact revision ID, and time; requesting changes records feedback and schedules another planning attempt. Editing or replacing the RFC invalidates an older approval for future builds. Repeated clicks must not start duplicate runs.

The build service validates the approval before launching a provider. A frontend button, task status, or agent claim is not sufficient proof of approval. If approval races with a new revision, the server rejects stale approval and returns the latest document for review.

### Completion and verification rules

Done means the task's agreed verification passed and the final artifacts are available. It does not mean the changes were merged, deployed, or published. Those actions are separate future workflows unless explicitly included and authorized.

Verification output includes a concise result, the steps actually performed, expected and observed behavior, pass/fail per check, timestamp, and code revision or snapshot identity. Screenshots and recordings are optional where the change benefits from them, and each has a caption describing what it demonstrates. Tests that were not run remain visibly unrun, with a reason. Capture failed checks as evidence as well.

The change list records added, modified, deleted, and renamed files, with line counts when available. It is captured from the task workspace against its recorded base, rather than trusted solely from prose supplied by an agent. Link to readable diffs and retain the result after the provider process exits.

## 5. Dispatcher requirements

1. A configurable global limit constrains all active local agent processes. Include the chief in the capacity model, or explicitly reserve a separately accounted chief slot; never silently exceed the displayed limit.
2. Runnable coding work is queued, has an available provider, has all required dependencies satisfied, is not already claimed, and has any phase-specific approval. Review-paused tasks consume no active process slot.
3. Selection uses priority, queue order, and creation time. Dispatcher pause prevents new launches while current work can finish.
4. Claiming work and capacity must be atomic. A second timer tick or server process cannot launch the same phase twice.
5. Runs have durable IDs, task ID, phase, attempt number, provider session ID when available, timestamps, and a lease/heartbeat. Startup reconciles interrupted runs; it must not silently assume an orphaned process completed successfully.
6. Retries preserve earlier attempts and artifacts. A build retry remains bound to the approved RFC. A materially revised plan requires fresh review.
7. Cancellation releases capacity when process shutdown is confirmed. Lowering capacity below current usage prevents new starts rather than killing unrelated work.
8. UI explains why a Todo task is waiting: capacity, unmet prerequisite, dispatcher paused, provider unavailable, or a required decision.

## 6. Worktree requirements

Place each coding task in a dedicated Git worktree and branch created by a workspace manager. Record the repository identity, base commit, branch, and worktree location. Pass that workspace to either provider through the same adapter contract. This makes isolation consistent and avoids depending on providers having matching native worktree behavior.

Planning, building, and verification for a task use the same isolated workspace unless a deliberate recovery action creates a replacement. Retries must not blindly reuse an unrelated path or overwrite another task's branch. Parent and child agents that can run simultaneously need separate workspaces.

Preserve worktrees and artifacts when they contain unmerged changes. Automated deletion is limited to known owned resources and must not destroy the user's existing checkout. The worktree abstraction should later map to a remote checkout or container without changing the task's public contract.

## 7. Attention semantics

| Kind | Why the owner sees it | Resolution |
| --- | --- | --- |
| RFC approval | A concrete plan is waiting | Approve exact revision or request changes |
| Decision required | Work cannot continue without an answer | Persist the answer and resume/replan |
| Execution failure | A run failed or provider is unavailable | Retry, change configuration/provider, or cancel |
| Task completed | Verified result is ready | Acknowledge after inspecting results |
| Project outcome completed | Required work for an explicit outcome is complete | Acknowledge the final outcome summary |

Sort actionable decisions before informational completions; within a group use priority and age. Open a card directly to the relevant RFC, failure explanation, or verification result. Show the owner the exact action, not a vague unread dot.

Model attention records with `recipientUserId`, task/project reference, kind, subject revision or run ID, `createdAt`, `readAt`, `resolvedAt`, and optional snooze time. Deduplicate by event/subject identity. A new RFC revision creates a new decision and resolves/supersedes the stale one. Reading, snoozing, and resolving are different operations. Ordinary progress changes do not need attention cards.

## 8. Boundaries that preserve a path to cloud and collaboration

| Interface / boundary | Initial local implementation | Future alternative |
| --- | --- | --- |
| Task and project repositories | SQLite transactions and migrations | PostgreSQL repositories |
| Unit of work | Local atomic transaction | Database transaction across equivalent repositories |
| Agent provider | Claude Code / Codex process adapters copied and adapted from Orca | Remote worker or managed provider |
| Run scheduler and capacity store | In-process tick with persistent claims | Durable queue and distributed leases |
| Workspace manager | Git worktrees | Remote checkout/container |
| Artifact store | Local managed files with metadata | Object storage |
| Event publisher/subscriber | Local event delivery after commit | Durable event bus/outbox |
| Attention delivery | Local web UI updates | Push/email/desktop delivery |
| Identity / authorization | Fixed local owner | Authenticated users and memberships |
| Clock and identifier generation | Local implementations | Same interfaces, useful in deterministic tests |

Domain services operate on IDs and typed records, not database driver objects, filesystem paths, HTTP requests, or provider output formats. Hono handlers validate input, establish actor/workspace scope, invoke services, and return stable DTOs. React consumes the API and renders business outcomes.

Include workspace/project scope in repository methods and authorization checks from the start. A future user identifier field alone is not sufficient for multi-user readiness: approvals must validate task ownership, attention must be recipient-scoped, and artifact access must validate its associated task. One local owner simplifies the implementation but should not spread global-user assumptions across services.

Use SQLite now if its driver is available in the chosen runtime. Keep schema migrations explicit and avoid leaking SQLite-only query behavior into domain services. Replacing it with PostgreSQL will still require migration and operational work; interface separation limits application changes rather than promising a cost-free switch.

## 9. Acceptance criteria for a usable first release

1. An owner can create a task and child, edit priority, and find both after a server restart.
2. The list, task detail, chief's links, and Attention all open the same persisted task.
3. A Claude-based chief creates or updates actual task records and returns a final summary; its tool/reasoning stream is not shown as product conversation.
4. With capacity set to two, no more than two accounted agent processes run; a review pause allows another eligible task to start.
5. An unapproved task cannot launch building through either the dispatcher or direct API requests.
6. Approving RFC revision 1 does not authorize revision 2. Duplicate approve requests cannot create duplicate build attempts.
7. Request changes records feedback and produces a fresh reviewable RFC; the task never silently advances to building.
8. Dependency cycles and parent cycles are rejected. A blocked prerequisite is explained in the task UI.
9. Concurrent coding tasks receive different worktrees. Changes in one do not enter another task's change list.
10. Claude Code and Codex run through the same application contract. Missing binaries/authentication produce an understandable failure, not fabricated agent output.
11. A completed task exposes its RFC decision, final summary, changed files, and real verification evidence. Merely exiting a process with code zero does not prove acceptance criteria passed.
12. A pending approval remains pending after the owner reads it. A completion acknowledgement clears its attention item without altering task results.
13. Server restart preserves tasks, approvals, attention, artifact metadata, and run history; interrupted work is reconciled visibly.
14. The API validates project/workspace scope and owner authority, even with the single seeded local identity.

## 10. Deliberate initial scope

Build the reliable owner-to-plan-to-verified-result loop first. Multiple project selection, multiple users, collaborative editing, cloud execution, remote databases, custom workflows, cycles, initiatives, external issue sync, automatic merging, and deployment are deferred. Interfaces and stored identity should permit those additions, while the shipped UI stays focused on one owner directing a local project.

The public-source study favors a familiar task model, concise list navigation, explicit ownership, and attention focused on actionable work. Muon's additional obligation is to turn agent execution into reviewable artifacts and enforce the human plan decision across every path that can launch code changes.
