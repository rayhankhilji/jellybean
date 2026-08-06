<!--
Thanks for sending this. Two things save a round trip:

  - If you changed how anything is parsed — a declaration pattern, an extent, a
    tokenisation rule — bump CACHE_VERSION in src/core/cache.ts. The cache is
    keyed by (path, size, mtime) and cannot notice that our own code changed, so
    without a bump every existing install keeps serving the old answer.

  - `npm test` runs the full suite, including the protocol test that drives the
    built server over stdio. It is the one that catches "the schema is fine but
    the SDK rejects it".
-->

## What this changes

## Why

<!-- If it fixes a defect, what the wrong behaviour was, and what made it wrong. -->

## How it was verified

<!--
Which tests cover it. If it is a performance change, the before and after
numbers and the repository they were measured on — the point of a benchmark is
that someone else can run it.
-->

- [ ] `npm test` passes
- [ ] `CACHE_VERSION` bumped, or parsing is unchanged
