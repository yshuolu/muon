# Library access, @ mentions, and thinking effort validation

Validated on September 25, 2026 (UTC).

- `pnpm run typecheck` passed.
- `pnpm test -- --run` passed: 361 tests in 33 files.
- `pnpm run build` passed. Vite reports its existing bundle-size advisory for the main chunk.

Why the planning partner could not see Library documents: planning chats and the chief run from a scratch directory with the repository attached read-only and Muon's data directory denied, and Library files live in the data directory, not the repository. The partner therefore reported "the repository contains only the initial commit" when asked about a document that existed only in the Library.

- Runtime tests cover the scratch-file writer (nested relative paths, rejection of absolute or escaping paths and of overwriting a copy) and confirm through the Claude Code fixture that request files exist in the scratch working directory when the session starts and disappear with it. Both adapters honor a per-run `effort` for every phase and fall back to the configured effort.
- Asset HTTP tests cover the copies handed to a planning reply and to the chief: current versions only (a superseded version is skipped), Markdown and text documents only (an image is skipped), duplicate names disambiguated with an ID suffix, and the prompt listing that names each copy with its asset ID.
- HTTP tests cover the planning chat `effort` field (validation, persistence in the listing, delivery to the run, a level the provider does not accept stored as `null`, reset on a provider switch), the `chiefEffort` setting (validation, delivery to chief runs, 409 while the chief runs, reset on an agent switch), and a task's `effort` on creation and edit; a service test checks that task runs carry the task's effort and drop a level the agent does not accept.
- Web unit tests cover mention detection at the caret (not inside words or e-mail addresses), matching current document versions with prefix matches first, and the inserted `[name](asset://ID)` reference with the caret placed after it.

Live check in the running app: typing `@` in the planning chat composer listed the AgentRouter Library documents, arrow keys and Enter inserted the reference, and the sent message rendered it as a link. The Thinking dropdown appeared beside the model in the planning chat and chief toolbars and in the task dialog and properties.
