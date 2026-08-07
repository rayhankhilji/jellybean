# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For Jelly Bean, the public surface that versioning promises apply to is: the
tool names and their argument schemas, the CLI flags, and the shape of tool
output that a client parses (handles, in practice). Rendering details — wording,
column order, which hint a footer suggests — can change in a minor release.

## [1.0.0] — 2026-08-06

First stable release. Nine tools, ten languages, and enough performance work to
run against a repository someone is actually paid to maintain.

### Tools

- **`jb_map`** — the repository ranked by structural importance, grouped by
  directory, with per-package attribution in a monorepo.
- **`jb_outline`** — a file's declarations without their bodies. About ten times
  cheaper than reading the file, and usually enough.
- **`jb_search`** — BM25 ranks files, then only the top files are read and their
  best lines extracted. Free-text, declaration-name, and regex modes.
- **`jb_read`** — read a region, normally by a handle returned from another tool
  rather than by guessing line numbers.
- **`jb_define`** — resolve a name to its definition by following the imports of
  the file that uses it, instead of guessing from the name alone.
- **`jb_trace`** — the import graph in either direction, so "what breaks if I
  change this" has an answer.
- **`jb_changes`** — the working diff attributed to the files it touches, with
  their dependents.
- **`jb_diagnose`** — run the project's own checks and return parsed
  diagnostics, not raw output.
- **`jb_notes`** — durable notes about the repository, stored in it.

Every tool takes a token budget and honours it. The footer says what was omitted
and how to get it, so a truncated answer is never mistaken for a complete one.

### Performance

Measured on real repositories (see `scripts/benchmark.mjs`, which reproduces
these):

| | express (213 files) | nest (2,125 files) |
|---|---|---|
| cold index | 475 ms | 2.3 s |
| warm start (parse cache present) | 42 ms | 509 ms |
| tool latency | 1–15 ms | 2–22 ms |
| one file saved → index up to date | 2–5 ms | 7–16 ms |
| retained heap | 7 MB | 18 MB |
| regex search matching nothing | — | 191 ms |
| tokens to orient in the repository | 236,235 → 749 | 1,284,820 → 1,878 |

The parse cache means a restart does not re-parse the repository. Filesystem
watching means an idle tool call costs nothing, and an edit costs the file that
changed rather than the tree it lives in.

On a repository large enough for the first scan to take real time — vscode, at
16,494 files — the server connects before indexing rather than after, so the
handshake completes in about half a second and all nine tools are listed
immediately. A call arriving while that scan is still running is told so, with a
file count, rather than blocking until the client gives up.

### Security

`jb_diagnose` never invokes a shell, and by default runs only the checks the
project itself declares. Every caller-supplied path is contained to the
workspace. No network I/O. See [SECURITY.md](SECURITY.md).

### Tooling

- `jellybean --doctor` reports what the server would actually see: the resolved
  root, index size and timing, whether the file cap truncated anything, whether
  filesystem watching works here, where the cache and notes live, and which
  commands `jb_diagnose` may run.
- `npm run demo` gives a guided tour of every tool against this repository.
- `node scripts/benchmark.mjs <repo>` reproduces the figures above against any
  repository, measuring the baselines rather than assuming them.

[1.0.0]: https://github.com/rayhankhilji/jellybean/releases/tag/v1.0.0
