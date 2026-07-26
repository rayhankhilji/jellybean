# Contributing

Thanks for looking. Issues and pull requests are both welcome.

## Getting set up

```bash
npm install
npm run build
npm test
```

There are no native dependencies and no code generation step. `npm test`
compiles to `dist-test/` and runs the suite with Node's built-in test runner.

To try your changes against a real repository:

```bash
node dist/index.js /path/to/some/repo
```

## Adding a language

This is the most common contribution and it is usually three small edits:

1. **`src/lang/registry.ts`** — map the file extension to a `LanguageId`, and
   give the language a syntax profile so the masking scanner knows what its
   comments and strings look like.
2. **`src/lang/patterns.ts`** — add a pattern list. Each entry needs a `kind`, a
   regex with a named `name` group, and occasionally `memberOnly` (matches only
   inside a class-like container) or `loose` (not anchored by a declaration
   keyword, so it gets filtered against `RESERVED_NAMES`).
3. **`test/outline.test.ts`** — add a test with a realistic snippet asserting
   names, kinds, extents, and visibility.

Then decide which of the three extraction strategies applies and register it in
`BRACE_LANGUAGES` or `INDENT_LANGUAGES` in `patterns.ts`. The strategies
themselves in `src/lang/outline.ts` rarely need changing.

If the language has a module system worth resolving, add a case to
`src/core/resolver.ts` — but only resolve what you can resolve unambiguously.
Recording an external dependency is correct; guessing an edge is not.

## Adding a diagnostic parser

Add a `scan*` function to `src/diagnostics/parsers.ts`, register it in
`parseDiagnostics`, and add a test with **real** captured output from the tool.
Fabricated samples tend to be tidier than the real thing and hide the cases that
matter. Overlapping parsers are fine — `dedupe` keeps the richer result.

## If you change how anything is parsed

**Bump `CACHE_VERSION` in `src/core/cache.ts`.**

Parses are cached on disk keyed by path, size and mtime. That key cannot notice
that *our* code changed, so a new declaration pattern, a corrected extent, or a
different tokenisation leaves every existing cache entry serving the old answer —
on files nobody has touched. The symptom is correct new code and confidently
stale results, which is a genuinely unpleasant afternoon.

This has already happened once, which is why the comment on that constant is as
loud as it is.

## Things the codebase cares about

- **Budgets are contracts.** Anything that emits rows goes through
  `BudgetWriter`, and the footer is written outside the budget via
  `pushAllUnchecked`. A truncated result must never look complete.
- **Output is not JSON.** The grammar lives in `src/core/render.ts`. Keep new
  output consistent with it, and remember that padding, repeated keys, and
  redundant fields all cost real tokens.
- **Never add a shell.** `jb_diagnose` spawns with an argv array and
  `shell: false`. That property is load-bearing; please do not relax it.
- **Paths go through `Workspace.resolve`.** It is the single place containment is
  enforced.
- **Comments explain *why*.** The code already says what it does. Prefer a note
  about the trade-off or the failure mode you are avoiding.

## Pull requests

- Keep `npm run typecheck` and `npm test` green. CI runs on Linux, macOS, and
  Windows against Node 20 and 22.
- Add a test for behaviour you change. The suite is fast — there is no reason not
  to.
- One concern per PR, please.
