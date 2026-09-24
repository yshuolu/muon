# Chief of staff agent validation

Validated on September 24, 2026 (UTC).

- `pnpm run typecheck` passed.
- `pnpm test -- --run` passed: 328 tests in 26 files.
- `pnpm run build` passed. Vite reports its existing bundle-size advisory for the main chunk.
- Adapter tests cover the Codex chief boundary with a controlled app-server: the run starts from a scratch working directory instead of the repository, uses the workspace-write sandbox with network access and the scratch directory as the only writable root, never uses full access even when `bypassPermissions` is enabled, passes the per-chief model, prefixes the prompt with the repository path, deletes the scratch directory afterwards, declines approval requests, and rejects a missing CLI capability, a launcher path with shell metacharacters, and a non-loopback API endpoint.
- HTTP tests cover the `chiefProvider` setting (validation, model reset on an agent switch, 409 while a chief request runs), routing a chief request to the Codex adapter with its scoped CLI credential and chosen model, the provider recorded on the assistant message, and returning to the Claude Code default.

Live validation used the real Codex CLI with the owner's login against an isolated data directory on port 4399, a freshly initialized plain-folder project (`PF`), and dispatch idle:

- `settings update --project PF --json '{"chiefProvider":"codex"}'` selected Codex.
- A chief request asked Codex to create a backlog task and summarize the tasks. Codex ran the scoped Muon CLI from inside its sandbox, created `PF-1 — Add README to the plain folder` in Backlog, and returned a one-sentence summary. The assistant message recorded `provider: codex` and the created task ID, and the repository received no changes.

The conversation transcript lives in Muon's database and is supplied to each chief run, so switching agents keeps the history; only tone and judgment change. Codex has no per-path read denials, so a Codex chief can read repository files that the Claude Code chief is denied, such as `.env`; this is documented in the README and architecture notes.
