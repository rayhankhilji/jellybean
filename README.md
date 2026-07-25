<div align="center">

# 🍬 Jelly Bean

**An MCP server that lets coding agents understand a codebase without reading it.**

Repository maps, symbol outlines, ranked search, import tracing, and parsed
diagnostics — every result under a token budget it actually honours.

[![CI](https://github.com/rayhankhilji/jellybean/actions/workflows/ci.yml/badge.svg)](https://github.com/rayhankhilji/jellybean/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/jellybean-mcp.svg)](https://www.npmjs.com/package/jellybean-mcp)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.17-3c873a.svg)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-1.29-6b4fbb.svg)](https://modelcontextprotocol.io)

</div>

---

## The problem

Most MCP servers are thin wrappers around `readFile` and `grep`. That makes them
easy to write and expensive to use. An agent asked to add a field to a service
typically burns through something like:

```
grep -rn "UserService"     →  240 matching lines, most of them imports
read src/user/service.ts   →  4,100 tokens, of which ~30 were relevant
read src/user/types.ts     →  1,800 tokens, to learn one interface
npm test                   →  3,900 lines of log for four real failures
```

Roughly 14,000 tokens to learn four facts. The context window fills with material
the model will never refer to again, and the useful signal is buried inside it.

Jelly Bean attacks this directly. Same task, same repository:

```
jb_map {focus:"user service"}          →  ~150 tokens, the five files that matter
jb_outline {path:"src/user/service.ts"} →  ~290 tokens, every declaration, no bodies
jb_read {handle:"jb_7c1e9a04"}          →  ~180 tokens, the one method
jb_diagnose {check:"test"}              →  ~220 tokens, four failures with source
```

Under 900 tokens, and the agent knows strictly more than it did above — because
it also knows what *else* is in those files, and what depends on them.

## Three ideas

Everything here follows from three decisions.

**1. Handles instead of dumps.** Every result is compact rows carrying an
identifier like `jb_7c1e9a04` that addresses an exact region of an exact file.
The agent spends tokens on a body only for the handles it chooses to follow.
Handles are content-derived, so the same region always yields the same handle —
an agent can tell that a search hit and an outline entry are the same function
without expanding either.

**2. Budgets are a contract, not a hint.** Every tool takes `tokenBudget` and
fits inside it, degrading detail rather than truncating mid-row. The footer always
reports what was omitted and names the one call that would reveal it, so a
truncated result is a signpost instead of a dead end.

**3. Structure over text.** Jelly Bean parses. It knows that a file contains a
class with nine methods, which of them are exported, which files import it, and
which of those are tests. A question about shape is answered from the index
rather than by shipping source to the model and hoping.

## Measured

Real numbers from this repository, using Jelly Bean's own token estimator:

| Target | Read in full | `jb_outline` | `jb_read` skeleton |
|---|---|---|---|
| `src/lang/outline.ts` | 5,962 | **724** — 88% less | 2,058 — 65% less |
| `src/core/code-index.ts` | 4,031 | **888** — 78% less | 2,026 — 50% less |
| `src/tools/search.ts` | 3,967 | **392** — 90% less | 1,380 — 65% less |
| `src/diagnostics/parsers.ts` | 4,343 | **527** — 88% less | 1,482 — 66% less |

And for whole-repository orientation — 38 files, 84,369 tokens of source:

| Call | Tokens | |
|---|---|---|
| Reading every file | 84,369 | — |
| `jb_map {depth:"symbols"}` | 2,663 | **97% less** |
| `jb_map {depth:"files"}` | 597 | **99% less** |
| `jb_map {depth:"tree"}` | 106 | **99.9% less** |

Reproduce with `npm run build && node dist/index.js --help`, or read
[`test/tools.test.ts`](test/tools.test.ts), where the budget guarantees are
asserted rather than asserted-in-prose.

## Install

Requires Node 18.17 or newer. No native modules, no build step at install time,
two runtime dependencies (the MCP SDK and Zod).

### Claude Code

```bash
claude mcp add jellybean -- npx -y jellybean-mcp /absolute/path/to/your/repo
```

### Claude Desktop, Cursor, Windsurf, Zed

Add to your MCP configuration file:

```json
{
  "mcpServers": {
    "jellybean": {
      "command": "npx",
      "args": ["-y", "jellybean-mcp", "/absolute/path/to/your/repo"]
    }
  }
}
```

### From source

```bash
git clone https://github.com/rayhankhilji/jellybean.git
cd jellybean
npm install && npm run build
node dist/index.js /path/to/your/repo
```

## The seven tools

### `jb_map` — orient yourself

Files ranked by structural importance: what other files import, weighted toward
being depended upon, because those are the files worth seeing first. Pass
`focus` to rank by topic instead.

```
jb_map {depth:"tree"}

jb_map — jellybean-mcp  38 files  7.3k lines  typescript×34 json×3 text×1

./  4 files  104L  json×3 text×1
  src/  3 files  494L  typescript×3
    core/  8 files  1.4kL  typescript×8
    diagnostics/  2 files  661L  typescript×2
    lang/  6 files  1.5kL  typescript×6
    tools/  8 files  1.7kL  typescript×8
    util/  1 file  85L  typescript×1
  test/  6 files  1.3kL  typescript×6

[106/2000 tok]
next: jb_map {path:"<dir>", depth:"symbols"} to see what a directory contains
```

`depth:"files"` gives one row per file with a handle and dependent count;
`depth:"symbols"` adds each file's top-level declarations.

### `jb_outline` — structure without bodies

The single largest saving on offer. Signatures, kinds, line ranges, visibility —
and a handle for each, so the two symbols that matter can be read in full
without paying for the other forty.

```
jb_outline {path:"src/core/handles.ts"}

jb_outline — src/core/handles.ts  1 file  17 symbols

src/core/handles.ts  87L  typescript  17 symbols
  export interface HandleTarget  jb_6dcfec6b  :16-27
    path: string  :18
    startLine: number  :20
    endLine: number  :22
    kind: string  :24
    label: string  :26
  export class HandleStore  jb_342e6a64  :40-76
    constructor(private readonly capacity = 4096) {}  jb_3bdc2fcf  :43
    mint(target: HandleTarget): string  jb_38a494b4  :46-58
    get(id: string): HandleTarget | undefined  jb_2ad5be16  :61-67
    get size(): number  jb_4f944248  :69-71
    clear(): void  jb_a2add99c  :73-75
  export function handleId(target: HandleTarget): string  jb_70f11a47  :79-82
  export function isHandle(value: string): boolean  jb_f1f2e211  :85-87

[282/700 tok]
```

Works on a directory too, in which case it defaults to exported symbols only.

### `jb_search` — ranked lines, not a list of files

BM25 over an inverted index ranks *files*; only the top ones are read, and their
best-matching lines extracted with the symbol that encloses each. Cost does not
scale with how common your search term is.

Natural words work: identifiers are indexed whole and split, so `retry backoff`
finds `retryWithBackoff`, `RETRY_BACKOFF_MS`, and `retry_with_backoff`.

```
jb_search {query:"least recently used eviction"}

jb_search — "least recently used eviction"  auto

src/core/handles.ts  3 hits  typescript
  → HandleStore  jb_342e6a64  :60
    /** Look up a handle, marking it as recently used. */
  → :37  jb_853fa374
    * least-recently-used, and because IDs are content-derived, an evicted handle
src/core/tokens.ts  8 hits  typescript
  → push  jb_b7a4164c  :110
    if (this.used + cost > this.budget - this.reserved) {
  … 2 more in this file
```

`mode:"symbol"` matches declaration names only and touches no files at all.
`mode:"regex"` takes an exact pattern.

### `jb_read` — exactly the region you meant

By handle, by symbol name, or by line range.

```
jb_read {path:"src/core/handles.ts", symbol:"HandleStore.mint"}

jb_read — src/core/handles.ts:46-58  mint (method)  typescript  of 87 lines

46|   mint(target: HandleTarget): string {
47|     const id = handleId(target);
48|     // Re-inserting moves the key to the end of the Map's iteration order, which
49|     // is what makes plain Map deletion order equal to LRU order.
50|     this.entries.delete(id);
51|     this.entries.set(id, target);
52|
53|     if (this.entries.size > this.capacity) {
54|       const oldest = this.entries.keys().next();
55|       if (!oldest.done) this.entries.delete(oldest.value);
56|     }
57|     return id;
58|   }
```

When you genuinely want a whole file, `mode:"skeleton"` keeps every declaration
and elides function bodies:

```
 71| export async function runSearch(args: SearchArgs, ctx: ToolContext): Promise<string> {
   | … 84 lines
156| }
157|
165| function buildTermMatcher(query: string): RegExp {
   | … 6 lines
172| }
```

### `jb_trace` — what breaks if I change this

Walks the import graph in either direction. For a symbol it also finds the real
reference sites — a file can import a module and never touch the symbol — and
labels dependents as tests, examples, or entrypoints, because those demand
different responses from whoever is making the change.

```
jb_trace {symbol:"estimateTokens"}

jb_trace — estimateTokens in src/core/tokens.ts  dependents  depth 1

⇒ depended on by
  test/core.test.ts  6 references  test
    → :12  jb_be12ae5d
    → :13  jb_7d224441
    … 2 more
  test/tools.test.ts  4 references  test
    → :168  jb_554f50fd
```

Notes anchored to the traced file surface here automatically.

### `jb_diagnose` — problems, not logs

Runs one of the project's own checks and returns deduplicated problems with file,
line, code, and the surrounding source. Overlapping excerpts are merged and the
offending lines marked, so three type errors in one function cost one excerpt.

```
jb_diagnose {check:"typecheck"}

jb_diagnose — npm run --silent typecheck  exit 2  9.7s  3 problems

src/app.ts  7L  3 problems
  ! Argument of type 'string' is not assignable to parameter of type 'number'.  TS2345  :4:21  jb_a543cb8c
  ! Expected 2 arguments, but got 1.  TS2554  :5:18  jb_a543cb8c
  ! Cannot find name 'missingHelper'.  TS2304  :6:10  jb_a543cb8c
     2|
     3| export function run(): number {
    >4|   const total = add("one", 2);
    >5|   const scaled = scale(total);
    >6|   return missingHelper(scaled);
     7| }

[154/2000 tok]
next: jb_read {handle:"jb_…"} to open the enclosing symbol of any problem
```

Call it with no arguments to list what the project offers. Output is understood
from `tsc`, ESLint, Vitest, Jest, `cargo`, `go`, pytest, Python tracebacks,
Maven, and the `path:line:col: severity: message` convention shared by gcc,
clang, ruff, flake8, and shellcheck. Unrecognised output falls back to a generic
scan and, failing that, the tail of the log — because "no problems found" is a
dangerous answer when a command has clearly failed.

**It never invokes a shell.** See [Security](#security).

### `jb_notes` — findings that outlive the session

A conclusion that cost twenty tool calls should be written down, not re-derived.
Notes anchored to paths resurface in `jb_trace` on those files.

```
jb_notes {action:"add",
          text:"Retry budget is deliberately shared across shards — see transport.ts:88.",
          paths:["src/transport.ts"], tags:["gotcha"]}
```

Stored as plain JSON at `.jellybean/notes.json` inside the workspace, so a human
can read, edit, review, or commit them. An agent's accumulated understanding of a
codebase should not be locked in a private store.

## Resources and prompts

Three resources mirror the cheapest calls, so a client that attaches resources
directly gets them without spending a tool call: `jellybean://map`,
`jellybean://checks`, `jellybean://notes`.

Two prompts encode the workflows: **onboard** (a token-efficient tour of an
unfamiliar repository) and **fix-failures** (diagnose → locate → trace → fix →
re-verify).

## Security

`jb_diagnose` is the only tool that runs anything, and its posture is explicit.

- **No shell, ever.** Commands are spawned with an argv array and `shell: false`.
  There is no globbing, no `$(…)`, no `;` chaining. A `command` of
  `echo hi; rm -rf /` runs `echo` with the literal arguments `hi;`, `rm`, `-rf`,
  `/` — which fails harmlessly.
- **Discovered checks only, by default.** Out of the box the runnable set is what
  the project declares: npm scripts, Make targets, and language defaults for
  cargo, go, pytest, and tsc. Anything else requires `--allow-command "<cmd>"`
  (prefix-matched) or the blunt `--unsafe-commands`.
- **Timeouts and output caps.** Runs are killed after 120 seconds by default and
  captured output is capped at 2 MB.
- **Path containment.** Every caller-supplied path passes through one function
  that rejects anything resolving outside the workspace root. Symlinks are not
  followed during walks — they can point outside the tree and create cycles.
- **Reads only what git would show.** `.gitignore` is honoured, including nested
  ones and negation, alongside a built-in list of directories never worth
  indexing. Binary files are detected and skipped.

Jelly Bean does no network I/O and writes exactly one file: the notes store.

## Configuration

```
jellybean [path] [options]

  -r, --root <path>         Workspace to index. Also the first positional argument.
      --token-budget <n>    Default budget per call (default 2000).
      --max-file-bytes <n>  Skip files larger than this (default 524288).
      --max-files <n>       Stop indexing after this many files (default 20000).
      --ignore <globs>      Extra comma-separated ignore patterns.
      --allow-command <c>   Permit jb_diagnose to run this command. Repeatable.
      --unsafe-commands     Permit jb_diagnose to run any command. Off by default.
      --command-timeout <s> Seconds before a check is killed (default 120).
  -h, --help                Show usage.
  -v, --version             Print the version.
```

Every option has an environment equivalent: `JELLYBEAN_ROOT`,
`JELLYBEAN_TOKEN_BUDGET`, `JELLYBEAN_MAX_FILE_BYTES`, `JELLYBEAN_MAX_FILES`,
`JELLYBEAN_IGNORE`, `JELLYBEAN_ALLOW_COMMANDS`, `JELLYBEAN_UNSAFE_COMMANDS`.

## Language support

Full outlines — declarations, nesting, visibility, doc comments:

**TypeScript** · **JavaScript** (+ JSX/TSX) · **Python** · **Go** · **Rust** ·
**Java** · **Kotlin** · **Swift** · **C#** · **C** · **C++** · **Ruby** ·
**PHP** · **Shell** · **SQL** · **Markdown** · **YAML** · **TOML** · **CSS**

Import graphs are resolved for TypeScript, JavaScript, Python (including relative
`from .` imports), Go, Rust (`crate::`, `super::`, `self::`), Java, Kotlin, C#,
C/C++, Ruby, PHP, and shell.

Parsing is regex-driven over a masked copy of the source. A tree-sitter grammar
per language would mean native builds, install failures, and version drift; for
an outline that needs a name, a kind, and a line range, that is a bad trade. The
masking pass is what makes it reliable — strings, comments, template literals,
regex literals, and Python docstrings are blanked out before any pattern runs, so
a brace inside a string cannot corrupt a symbol's extent.

## Architecture

```
src/
  index.ts              CLI entry; stdio transport
  server.ts             Tool, resource, and prompt registration
  config.ts             Flags and environment
  core/
    workspace.ts        Path containment, walking, reading
    ignore.ts           .gitignore-compatible matcher
    code-index.ts       File records, inverted index, import graph
    resolver.ts         Module specifier → workspace file, per language
    handles.ts          Content-derived region references (LRU)
    tokens.ts           Estimation and budget enforcement
    render.ts           The shared output grammar
    notes.ts            Persistent findings
  lang/
    scanner.ts          String/comment masking, offset-preserving
    patterns.ts         Declaration patterns per language
    outline.ts          Symbol extraction (brace / indent / line strategies)
    imports.ts          Import extraction
    registry.ts         Extension → language → syntax profile
  diagnostics/
    runner.ts           Check discovery; shell-free execution
    parsers.ts          Tool output → structured diagnostics
  tools/                One module per tool
```

Two properties are worth knowing about the index. It is **incremental**: a rescan
re-parses only files whose size or mtime changed, so editing one file in a
5,000-file repository costs one reparse. And search is **two-stage**: BM25 ranks
files from the inverted index, then only the top files are read to locate lines —
storing line-level postings would be far larger for no ranking benefit.

## Development

```bash
npm install
npm run build       # compile to dist/
npm test            # 109 tests
npm run typecheck   # no emit
```

The suite covers the masking scanner (template nesting, regex-versus-division,
unterminated strings), symbol extraction across five languages, gitignore
semantics, budget enforcement, handle eviction, every diagnostic parser, and an
end-to-end pass over a real temporary workspace — plus a protocol test that
drives the built server over stdio with a real MCP client, because unit tests can
pass while a server fails to speak the protocol at all.

## Design notes

A few decisions that might look arbitrary:

**Output is not JSON.** Braces, quotes, and repeated key names roughly double the
token cost of a result, and a model parses aligned rows just as reliably. The
grammar is defined once in `core/render.ts`.

**The token estimator over-estimates slightly.** A budget that is true on average
is not a contract. The estimator blends character density with symbol counting,
so `});` is charged as three tokens rather than one.

**Ambiguity is not resolution.** When the resolver cannot uniquely determine what
a specifier points at, it records an external dependency instead of guessing. A
wrong graph edge is worse than a missing one.

**The footer is written outside the budget.** Every tool reserves tokens for it.
Losing the footer to a full budget would present a truncated result as a complete
one, which is the worst failure this design can have.

## Contributing

Issues and pull requests are welcome. Adding a language usually means one entry
in `lang/registry.ts`, a pattern list in `lang/patterns.ts`, and a test in
`test/outline.test.ts` — the three strategies in `lang/outline.ts` rarely need
touching.

## License

MIT © 2026 — see [LICENSE](LICENSE).
