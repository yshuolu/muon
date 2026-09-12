# TypeScript Code Guidelines

Muon follows the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html).
This document is a working summary for routine changes; the linked guide is
the authority for details and edge cases. Agents should read the original
reference when a rule is unclear or a change involves a nuanced language or
formatting choice.

## Formatting and Files

- Use UTF-8 source files and spaces for indentation; do not use tabs.
- Use the repository formatter and compiler configuration as the final authority
  for formatting that is not settled by this document.
- Keep imports explicit, use named imports where practical, and remove unused
  imports. Keep module boundaries clear.
- Prefer one logical statement per line and use semicolons consistently.

## Naming and Declarations

- Use `UpperCamelCase` for classes, interfaces, type names, enums, and React
  components.
- Use `lowerCamelCase` for variables, functions, methods, and properties.
- Use `CONSTANT_CASE` only for true module-level constants whose values are
  fixed by design; do not force it on ordinary locals.
- Do not use leading or trailing underscores to mark visibility. Use TypeScript
  access modifiers and module boundaries instead.
- Prefer `const`; use `let` only when reassignment is required. Avoid `var`.
- Prefer small, cohesive functions and classes with explicit inputs and
  outputs. Avoid clever compression that hides control flow.

## Types and APIs

- Keep types precise. Avoid `any`; use a narrower type, a generic, or `unknown`
  with runtime validation when the shape is not known.
- Use `interface` for extendable object contracts and `type` for unions,
  intersections, mapped types, and other compositions when that matches the
  surrounding code.
- Model absent values explicitly with optional properties or `null`; do not
  use sentinel strings or unchecked casts.
- Validate data at boundaries, especially HTTP input, persisted JSON, and
  provider output. Keep core application code independent of framework and transport
  details.
- Prefer immutable inputs and return values. Do not mutate objects owned by a
  caller unless the local API explicitly requires it.

## Control Flow and Errors

- Prefer strict equality (`===` and `!==`), optional chaining, and nullish
  coalescing where they make intent clear.
- Use `async`/`await` for asynchronous control flow. Handle or deliberately
  propagate every promise; do not leave floating promises without an explicit
  reason.
- Throw or return errors with useful context at the boundary where an error can
  be understood. Do not catch errors merely to rethrow the same value.
- Avoid broad suppression such as `as any`, empty catches, or disabling lint or
  type checks. If an exception is necessary, keep it local and explain why.

## Comments and Tests

- Write comments for non-obvious invariants, security boundaries, or reasoning
  that is not apparent from the code. Do not narrate straightforward syntax.
- Use JSDoc for public APIs when callers need contract, lifecycle, or usage
  information.
- Extend focused tests when behavior or a cross-module contract changes. Keep
  tests deterministic and verify outcomes rather than implementation details.

For the complete normative guidance, consult the [Google TypeScript Style
Guide](https://google.github.io/styleguide/tsguide.html).
