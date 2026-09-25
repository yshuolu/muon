# Document review validation

Validated on September 25, 2026 (UTC).

- `pnpm run typecheck` passed.
- `pnpm test -- --run` passed: 350 tests in 31 files.
- `pnpm run build` passed. Vite reports its existing bundle-size advisory for the main chunk.
- Repository tests cover the schema version 4 migration (`asset_comments` with a unique request ID per document and an indexed status) and rejection of newer schemas.
- Asset HTTP tests cover comment creation with a selection anchor and for the whole document, idempotent resubmission by `requestId` (same content returns the stored comment, different content returns 409), rejection of non-UUID request IDs and of comments on non-Markdown assets, editing and deleting pending comments only, the pending-count listing, chief credentials reading but not writing or resolving comments, a full resolve run through a controlled Codex adapter chosen from the latest planning chat (one answered and one changed reply plus a revised document → a generated asset with `previousVersionId`, replies and `revisionAssetId` on every comment, the inherited thread on the revision, and 409 for late edits or a second run), and failure handling (a changed reply without a document, an unparseable result, and an interrupted run all leave the comments pending with `lastError`, with no revision created).
- Web unit tests cover whitespace-insensitive anchor location with prefix/suffix scoring and nearest-offset ties, anchor creation from a selection, reading-order sorting with whole-document comments last, and the rehype plugin that splits hast text nodes into `<mark>` elements across inline elements and blocks without touching unanchored text.

Live validation used the built app against an isolated data directory on port 4399 with the real Claude Code CLI (the project had no planning chat, so the reviewer defaulted to Claude Code):

- Selecting a sentence in a Markdown document showed the floating **Comment** control; the composer quoted the selection, and the saved comment was highlighted in the text and listed in the sidebar with the pending count on the toggle.
- **On document** added a whole-document instruction ("Remove the Decision log section entirely.").
- **Resolve 2 comments** occupied one agent slot, showed the run's activity, and finished with both comments resolved: the question got an **Answered** reply beside it, the instruction a **Changed** reply describing the removal, and the highlight turned green.
- The revised document was created as a new Library version (200 bytes, `Generated`) containing exactly the original text minus the Decision log section. The sidebar offered **Open revised version**, which opened the revision as a second tab showing "Revised from an earlier version · 2 comments resolved", **Open previous version**, and the inherited thread.
- The repository folder was unchanged throughout.

A later live review of a 4-comment document at the task effort (`max`) took over 15 minutes: the agent spent eight minutes thinking before its first action, listed the repository, and tried to write its draft to a temp file with a heredoc that the sandbox refused. Reviews now run at `MUON_REVIEW_EFFORT` (default `high`, covered by adapter tests for both Claude Code and Codex, which keep task phases at the configured effort), and the prompt tells the reviewer to compose the revision in its reply without exploring the repository or writing files. With the comments sidebar open the reader also drops its centered reading width so the outline, the text, and the 360px sidebar share the window.

This validation concerns commenting, one-pass resolution, and versioning. The reader, tabs, and Library list remain covered by [library-validation.md](library-validation.md).
