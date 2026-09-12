# Asset validation

Validated on September 12, 2026 (UTC).

- `pnpm run typecheck` passed.
- `pnpm test -- --run` passed: 221 tests in 22 files.
- `pnpm run build` passed. Vite reports a bundle-size advisory for the main chunk.
- HTTP tests cover private/project access independent of references, scoped metadata and content, multipart uploads, immutable downloads, byte ranges, Unicode filenames, and changed-file containment.
- Workflow tests cover resolving text references into isolated input copies, retaining references in the reviewed RFC, and keeping generated reports discoverable after failed verification and a later retry.
- Storage tests cover database reopening/migration, idempotent legacy import, immutable publication, checksums, and symlink/path rejection.

Browser validation used the in-app browser against an isolated SQLite backup with provider execution disabled. It retained the existing MUO-1 comparison report through the application service and checked:

- Opening the report from its result reference.
- Rendered Markdown headings, tables, heading navigation, and original source view.
- Reader state surviving multiple workspace polling refreshes.
- Inline image references, loaded image dimensions, and expansion.
- Copying an image reference through the reader action.

The report download preserved all 88,942 original bytes with SHA-256 `bc9dca30eb0448e3b379158e4e3b38fb4080e9a452e675cd7678ed7369fbf77d`. This validation concerns storage and rendering, not the report's research claims or its earlier verification outcome.

Local fixture records and command logs are retained under `/Users/yshuolu/Develop/muon-assets/.muon/validation/assets-ui/`.
