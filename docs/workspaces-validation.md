# Multi-workspace validation

Validated on September 23, 2026 (UTC).

- `pnpm run typecheck` passed.
- `pnpm test -- --run` passed: 322 tests in 26 files.
- `pnpm run build` passed. Vite reports its existing bundle-size advisory for the main chunk.
- Registry and HTTP tests cover seeding the first workspace, `GET /workspaces` and `GET /workspaces/:workspace` by ID or identifier, workspace creation with repository validation, identifier derivation and uniqueness (`Second app` → `SA`, then `SA2` for a second binding of the same repository), per-workspace task isolation and identifiers (`SA-1`), cross-workspace relation rejection, rename and rebind through `PATCH /workspaces/:workspace`, archive refusal while a planning agent runs, archive/restore lifecycle with records preserved, default-workspace fallback for unprefixed routes and 404 when every workspace is archived, reloading workspaces and archived state from the database, and chief credentials bound to the workspace that opened them (403 for other workspaces and unprefixed paths, no workspace mutations).
- Chief gateway tests cover the `MUON_WORKSPACE` line in the frozen launcher, identifier resolution for workspace prefixes, and same-workspace sessions for several workspaces.
- CLI and client tests cover `workspaces list|create|archive|restore`, `--workspace` overriding `MUON_WORKSPACE`, prefixing of workspace-scoped paths including `api` escape-hatch paths, and untouched workspace paths.
- `pnpm run test:browser` and `pnpm run test:browser:scroll` passed with the workspace-prefixed routes (see the notes in [browser-validation.md](browser-validation.md) and [conversation-scroll-validation.md](conversation-scroll-validation.md), which those scripts regenerate).

Browser validation used the built app in demo mode on an isolated data directory with dispatch paused and no model calls. It checked:

- A legacy `/tasks` URL redirects to `/workspaces/local-project/tasks`; the sidebar lists the seeded workspace with its task count and an **Add workspace** action.
- **Add workspace** with a name and the absolute path of a Git repository root creates the workspace, shows it in the sidebar, and switching to it shows an empty task list, zero attention, its own `BS` identifier, and its own empty chief conversation; sending a demo chief message stays in that workspace.
- The CLI created a third workspace, created `CP-1` inside it with `--workspace CP`, listed tasks per workspace with `MUON_WORKSPACE` and `--workspace`, archived it (its routes then returned `Workspace is archived`), restored it, and read the default workspace's state with the full workspace list.
- **Workspace settings** shows the workspace's name, repository, prefix, and an **Archive** action with confirmation; archiving switched the app to the remaining workspace and removed the archived one from the switcher, and **Restore** in the archived list brought it back.

This validation concerns workspace routing, lifecycle, and isolation. Task workflows, assets, and conversations remain covered by their own validation records.
