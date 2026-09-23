# Library validation

Validated on September 22, 2026 (UTC).

- `pnpm run typecheck` passed.
- `pnpm test -- --run` passed: 312 tests in 25 files.
- `pnpm run build` passed. Vite reports its existing bundle-size advisory for the main chunk.
- HTTP tests cover the project-wide `GET /assets` listing (owner files plus project-visible files, never another owner's private files), note creation with `.md` normalization and trimmed content, rejection of blank, oversized, path-like, and multipart note requests, and chief credentials that can list the library but cannot write notes.
- Web unit tests cover library type grouping, newest-first ordering, combined type/source/search filters, search over source paths and referencing tasks, and the derived asset-to-task referrer map.

Browser validation used the built app in demo mode on an isolated data directory with dispatch paused and no model calls. It checked:

- The **Library** sidebar entry, `/library` heading, toolbar, and empty reader summary with per-type counts.
- Selecting a file updates the URL to `/library/ASSET-ID`, shows type, source, size, visibility, and **Referenced by** with a link to the referencing task, and renders the existing Markdown reader with outline, source view, copy reference, and download.
- **New note** with name, Markdown content, **Preview**, and save; the note appeared first in the list, was selected, and rendered its `asset://` link to another library file.
- **Revise as new note** opened the composer prefilled with the note's name and content.
- Search matched a file by the identifier of the task that references it.
- **Open in Library** on a task's Assets tab opened the same file in the library.
- Chromium at 400 px and 800 px wide stacked the catalog above the reader with no horizontal overflow and no console errors.

This validation concerns the library view, note creation, and navigation; storage, preview rendering, and authorization behavior remain covered by [assets-validation.md](assets-validation.md).
