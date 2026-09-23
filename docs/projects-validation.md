# Multi-project validation

Validated on September 23, 2026 (UTC).

- `pnpm run typecheck` passed.
- `pnpm test -- --run` passed: 322 tests in 26 files.
- `pnpm run build` passed. Vite reports its existing bundle-size advisory for the main chunk.
- Registry and HTTP tests cover seeding the first project, `GET /projects` and `GET /projects/:project` by ID or identifier, project creation with repository validation, identifier derivation and uniqueness (`Second app` → `SA`, then `SA2` for a second binding of the same repository), per-project task isolation and identifiers (`SA-1`), cross-project relation rejection, rename and rebind through `PATCH /projects/:project`, archive refusal while a planning agent runs, archive/restore lifecycle with records preserved, default-project fallback for unprefixed routes and 404 when every project is archived, reloading projects and archived state from the database, and chief credentials bound to the project that opened them (403 for other projects and unprefixed paths, no workspace mutations).
- Chief gateway tests cover the `MUON_PROJECT` line in the frozen launcher, identifier resolution for project prefixes, and same-workspace sessions for several projects.
- CLI and client tests cover `projects list|create|archive|restore`, `--project` overriding `MUON_PROJECT`, prefixing of project-scoped paths including `api` escape-hatch paths, and untouched workspace paths.
- `pnpm run test:browser` and `pnpm run test:browser:scroll` passed with the project-prefixed routes (see the notes in [browser-validation.md](browser-validation.md) and [conversation-scroll-validation.md](conversation-scroll-validation.md), which those scripts regenerate).

Browser validation used the built app in demo mode on an isolated data directory with dispatch paused and no model calls. It checked:

- A legacy `/tasks` URL redirects to `/projects/local-project/tasks`; the sidebar lists the seeded project with its task count and an **Add project** action.
- **Add project** with a name and the absolute path of a Git repository root creates the project, shows it in the sidebar, and switching to it shows an empty task list, zero attention, its own `BS` identifier, and its own empty chief conversation; sending a demo chief message stays in that project.
- The CLI created a third project, created `CP-1` inside it with `--project CP`, listed tasks per project with `MUON_PROJECT` and `--project`, archived it (its routes then returned `Project is archived`), restored it, and read the default project's state with the full project list.
- **Project settings** shows the project's name, repository, prefix, and an **Archive** action with confirmation; archiving switched the app to the remaining project and removed the archived one from the switcher, and **Restore** in the archived list brought it back.

This validation concerns project routing, lifecycle, and isolation. Task workflows, assets, and conversations remain covered by their own validation records.
