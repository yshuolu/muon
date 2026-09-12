# Chief SOUL validation

Validated 2026-09-12 in an isolated SQLite, HTTP, and browser fixture.

- The Chief SOUL editor opened from the Chief composer, accepted Markdown, rendered a live preview, and autosaved `## Voice\n\nBe concise.` to the project settings.
- The saved SOUL appeared in the Chief provider prompt while the existing owner-only settings boundary and approval instructions remained in force.
- `pnpm run typecheck` passed.
- `pnpm test -- --run` passed: 239 tests.
- `pnpm run build` passed.

The broader legacy browser acceptance script currently fails before the Chief flow because it assumes a global provider-call index and then attempts to click a covered task row. The focused SOUL browser fixture passed independently.
