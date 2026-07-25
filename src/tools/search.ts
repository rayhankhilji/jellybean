/**
 * `jb_search` — ranked search that returns lines, not files.
 *
 * `grep -rn` is either too narrow (you must already know the exact token) or
 * far too wide (one common word, four hundred hits, most of them a comment).
 * This tool splits the difference:
 *
 *   1. BM25 over the inverted index ranks *files* by relevance.
 *   2. Only the top files are read, and their best matching lines extracted.
 *   3. Each hit is reported with the symbol that encloses it — which is usually
 *      the thing the agent actually wanted to know.
 *
 * The result is a couple of dozen lines that say where the concept lives, at a
 * cost that does not depend on how common the search term is.
 */

import { z } from 'zod';
import type { FileRecord } from '../core/code-index.js';
import type { CodeSymbol } from '../lang/types.js';
import { BudgetWriter } from '../core/tokens.js';
import { fields, FOOTER_RESERVE, footer, GLYPH, header, indent, plural } from '../core/render.js';
import { escapeRegExp, splitIdentifier, toLines, truncate } from '../util/text.js';
import { resolveBudget, tokenBudgetArg, type ToolContext } from './context.js';

export const searchSchema = {
  query: z
    .string()
    .min(1)
    .describe('What to look for. Natural words work: "retry backoff" matches retryWithBackoff and RETRY_BACKOFF_MS.'),
  mode: z
    .enum(['auto', 'symbol', 'regex'])
    .optional()
    .describe(
      '"auto" (default) ranks by relevance across names and bodies. "symbol" matches declaration names only. "regex" treats the query as a JavaScript regular expression.',
    ),
  path: z.string().optional().describe('Restrict the search to a subdirectory.'),
  language: z.string().optional().describe('Restrict to one language, e.g. "python".'),
  maxFiles: z.number().int().min(1).max(100).optional().describe('How many distinct files to report. Default 12.'),
  contextLines: z
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe('Lines of surrounding source to show for each hit. Default 0 — the matched line alone.'),
  tokenBudget: tokenBudgetArg,
};

type SearchArgs = {
  query: string;
  mode?: 'auto' | 'symbol' | 'regex';
  path?: string;
  language?: string;
  maxFiles?: number;
  contextLines?: number;
  tokenBudget?: number;
};

/** How many candidate files to read line-by-line. Beyond this, ranking is noise. */
const CANDIDATE_FILES = 60;
/** Hits shown per file before we assume the rest are more of the same. */
const MAX_HITS_PER_FILE = 6;

interface Hit {
  line: number;
  text: string;
  score: number;
  symbol: CodeSymbol | undefined;
}

export async function runSearch(args: SearchArgs, ctx: ToolContext): Promise<string> {
  await ctx.index.ensureFresh();

  const budget = resolveBudget(ctx, args.tokenBudget);
  const mode = args.mode ?? 'auto';
  const maxFiles = args.maxFiles ?? 12;
  const contextLines = args.contextLines ?? 0;
  const prefix = args.path ? args.path.replace(/^\.?\/+/, '').replace(/\/+$/, '') + '/' : '';

  const accepts = (file: FileRecord): boolean =>
    (prefix === '' || file.path.startsWith(prefix)) &&
    (!args.language || file.language === args.language) &&
    !file.skipped;

  if (mode === 'symbol') return renderSymbolSearch(args, ctx, budget, accepts, maxFiles);

  let matcher: RegExp;
  try {
    matcher = mode === 'regex' ? new RegExp(args.query, 'g') : buildTermMatcher(args.query);
  } catch (error) {
    return `jb_search — invalid regular expression: ${(error as Error).message}`;
  }

  const candidates =
    mode === 'regex'
      ? ctx.index.all().filter(accepts)
      : ctx.index
          .searchFiles(args.query, CANDIDATE_FILES * 3)
          .map((hit) => hit.file)
          .filter(accepts)
          .slice(0, CANDIDATE_FILES);

  const writer = new BudgetWriter(budget, FOOTER_RESERVE);
  writer.pushUnchecked(
    header('jb_search', fields(`"${truncate(args.query, 60)}"`, mode, prefix ? `in ${prefix}` : null)),
  );
  writer.pushUnchecked('');

  let filesShown = 0;
  let totalHits = 0;
  let filesScanned = 0;

  for (const file of candidates) {
    if (filesShown >= maxFiles) break;

    const text = await ctx.workspace.readText(file.path, ctx.config.maxFileBytes);
    if (text === null) continue;
    filesScanned++;

    const hits = findHits(text, matcher, file);
    if (hits.length === 0) continue;

    filesShown++;
    totalHits += hits.length;

    // Collapse hits that share an enclosing symbol: six matches inside one
    // function are one place to look, and repeating its handle six times is
    // pure waste. The best-scoring line stands in for the rest.
    const shown = dedupeBySymbol(hits).slice(0, MAX_HITS_PER_FILE);
    if (!writer.push(fields(file.path, plural(hits.length, 'hit'), file.language))) break;

    let exhausted = false;
    for (const hit of shown) {
      if (!renderHit(hit, file, ctx, writer, contextLines, text)) {
        exhausted = true;
        break;
      }
    }
    if (exhausted) break;
    if (hits.length > shown.length) {
      writer.push(indent(1, `… ${hits.length - shown.length} more in this file`));
    }
  }

  if (filesShown === 0) {
    writer.pushUnchecked(
      `no matches${filesScanned > 0 ? ` in ${plural(filesScanned, 'candidate file')}` : ''}. Try mode:"symbol" for declaration names, or a broader query.`,
    );
  }

  writer.pushAllUnchecked(
    footer(
      writer,
      budget,
      totalHits > 0 ? 'jb_read {handle:"jb_…"} to open a hit with full context' : 'jb_map {focus:"<topic>"} to find the right area first',
    ),
  );
  return writer.toString();
}

/**
 * Build a matcher for free-text mode.
 *
 * The query is split into sub-words so "http response" finds `parseHTTPResponse`,
 * and each alternative is bounded by non-identifier characters so "id" does not
 * match every `valid`, `hidden`, and `identity` in the repository.
 */
function buildTermMatcher(query: string): RegExp {
  const terms = [...new Set([...splitIdentifier(query), ...query.toLowerCase().split(/\s+/)])]
    .filter((term) => term.length >= 2)
    .map(escapeRegExp);

  if (terms.length === 0) return new RegExp(escapeRegExp(query), 'gi');
  return new RegExp(`(?<![A-Za-z0-9_])(${terms.join('|')})`, 'gi');
}

function findHits(text: string, matcher: RegExp, file: FileRecord): Hit[] {
  const lines = toLines(text);
  const hits: Hit[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 500) continue; // minified or generated

    matcher.lastIndex = 0;
    const matched = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = matcher.exec(line)) !== null) {
      matched.add(m[0].toLowerCase());
      if (m[0].length === 0) matcher.lastIndex++; // zero-width match guard
      if (matched.size > 8) break;
    }
    if (matched.size === 0) continue;

    const symbol = enclosingSymbol(file.symbols, i + 1);

    // Distinct terms matter more than repetition; a line that mentions both
    // "retry" and "backoff" is a better hit than one saying "retry" four times.
    let score = matched.size * 2;
    if (symbol && symbol.startLine === i + 1) score += 5; // the declaration itself
    else if (symbol) score += 1;
    if (/^\s*(?:\/\/|#|\*)/.test(line)) score -= 1; // a comment is weaker evidence

    hits.push({ line: i + 1, text: line, score, symbol });
  }

  return hits.sort((a, b) => b.score - a.score || a.line - b.line);
}

/**
 * Keep the best hit per enclosing symbol.
 *
 * Hits outside any symbol keep their own identity — they are separate places in
 * the file, not repeated views of one declaration.
 */
function dedupeBySymbol(hits: readonly Hit[]): Hit[] {
  const bySymbol = new Map<string, Hit>();
  const loose: Hit[] = [];

  for (const hit of hits) {
    if (!hit.symbol) {
      loose.push(hit);
      continue;
    }
    const key = `${hit.symbol.startLine}:${hit.symbol.name}`;
    const existing = bySymbol.get(key);
    if (!existing || hit.score > existing.score) bySymbol.set(key, hit);
  }

  return [...bySymbol.values(), ...loose].sort((a, b) => b.score - a.score || a.line - b.line);
}

function renderHit(
  hit: Hit,
  file: FileRecord,
  ctx: ToolContext,
  writer: BudgetWriter,
  contextLines: number,
  text: string,
): boolean {
  const handle = ctx.handles.mint(
    hit.symbol
      ? { path: file.path, startLine: hit.symbol.startLine, endLine: hit.symbol.endLine, kind: hit.symbol.kind, label: hit.symbol.name }
      : { path: file.path, startLine: hit.line, endLine: hit.line, kind: 'match', label: `${file.path}:${hit.line}` },
  );

  // With a symbol the row reads `→ name  handle  :line`; without one the name
  // would just be the line number again, so it is left out.
  const row = indent(
    1,
    hit.symbol
      ? fields(`${GLYPH.match} ${hit.symbol.name}`, handle, `:${hit.line}`)
      : fields(`${GLYPH.match} :${hit.line}`, handle),
  );
  if (!writer.push(row)) return false;

  if (contextLines === 0) {
    return writer.push(indent(2, truncate(hit.text.trim(), 200)));
  }

  const lines = toLines(text);
  const from = Math.max(0, hit.line - 1 - contextLines);
  const to = Math.min(lines.length, hit.line + contextLines);
  for (let i = from; i < to; i++) {
    const marker = i === hit.line - 1 ? '>' : ' ';
    if (!writer.push(indent(2, `${marker}${i + 1}| ${truncate(lines[i]!, 200)}`))) return false;
  }
  return true;
}

/** The innermost symbol whose range contains a line. */
function enclosingSymbol(symbols: readonly CodeSymbol[], line: number): CodeSymbol | undefined {
  let best: CodeSymbol | undefined;
  for (const symbol of symbols) {
    if (line < symbol.startLine || line > symbol.endLine) continue;
    if (!best || symbol.depth > best.depth) best = symbol;
  }
  return best;
}

/** Declaration-name search: no file reads at all, straight from the index. */
function renderSymbolSearch(
  args: SearchArgs,
  ctx: ToolContext,
  budget: number,
  accepts: (file: FileRecord) => boolean,
  maxFiles: number,
): string {
  const needle = args.query.toLowerCase();
  const terms = splitIdentifier(args.query);

  interface SymbolHit {
    file: FileRecord;
    symbol: CodeSymbol;
    score: number;
  }
  const hits: SymbolHit[] = [];

  for (const file of ctx.index.all()) {
    if (!accepts(file)) continue;
    for (const symbol of file.symbols) {
      const name = symbol.name.toLowerCase();
      let score = 0;
      if (name === needle) score = 100;
      else if (name.startsWith(needle)) score = 60;
      else if (name.includes(needle)) score = 40;
      else {
        const parts = splitIdentifier(symbol.name);
        const overlap = terms.filter((t) => parts.includes(t)).length;
        if (overlap === 0) continue;
        score = 10 * overlap;
      }
      if (symbol.exported) score += 5;
      if (symbol.depth === 0) score += 3;
      hits.push({ file, symbol, score });
    }
  }

  hits.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));

  const writer = new BudgetWriter(budget, FOOTER_RESERVE);
  writer.pushUnchecked(
    header('jb_search', fields(`"${truncate(args.query, 60)}"`, 'symbol', plural(hits.length, 'match', 'matches'))),
  );
  writer.pushUnchecked('');

  if (hits.length === 0) {
    writer.pushUnchecked('no symbol names matched. Try mode:"auto" to search inside bodies too.');
  }

  const seenFiles = new Set<string>();
  for (const hit of hits) {
    if (!seenFiles.has(hit.file.path)) {
      if (seenFiles.size >= maxFiles) break;
      seenFiles.add(hit.file.path);
    }
    const handle = ctx.handles.mint({
      path: hit.file.path,
      startLine: hit.symbol.startLine,
      endLine: hit.symbol.endLine,
      kind: hit.symbol.kind,
      label: hit.symbol.name,
    });
    const row = fields(
      `${hit.symbol.name}`,
      hit.symbol.kind,
      handle,
      `${hit.file.path}:${hit.symbol.startLine}`,
      hit.symbol.exported ? null : 'private',
    );
    if (!writer.push(row)) break;
  }

  writer.pushAllUnchecked(footer(writer, budget, 'jb_read {handle:"jb_…"} to read a declaration'));
  return writer.toString();
}
