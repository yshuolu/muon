# Agent Instructions

These instructions apply to the entire repository.

## Project Context

Muon is a local, task-first workspace for coordinating Claude Code and Codex
agents. Keep the workflow reviewable: plans require owner approval before code
changes, work happens in isolated Git worktrees, and verification evidence is
durable.

## Source Changes

- Read the relevant existing code, tests, and documentation before editing.
- Preserve the existing TypeScript, React, Hono, SQLite, and provider-adapter
  boundaries. Prefer local patterns and existing abstractions.
- Keep changes focused. Do not rewrite generated output in `dist/`, commit
  dependencies, or change unrelated formatting and metadata.
- Treat provider output as untrusted data. Do not bypass approval, sandbox, or
  workspace isolation rules to make a task pass.
- Keep user-visible behavior accessible and consistent with the existing UI.

## Coding Style

Follow [CODE_GUIDELINES.md](CODE_GUIDELINES.md). It summarizes the required
TypeScript conventions and links to the complete Google TypeScript Style Guide.
When a rule is ambiguous, nuanced, or not covered by the summary, read the
original guide before choosing an implementation.

## Validation

Run the narrowest relevant checks while iterating. Before finishing a change,
run at least:

```bash
pnpm run typecheck
pnpm test -- --run
```

For changes to the production bundle, also run `pnpm run build`. Report any
check that could not run and why.

## Documentation

Update the relevant README or `docs/` document when behavior, configuration,
runtime requirements, or public API contracts change. Keep documentation
concise and use the repository's existing terminology.
