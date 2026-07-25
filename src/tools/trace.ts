/**
 * `jb_trace` — what depends on this, and what does this depend on.
 *
 * The question behind most real edits is "what breaks if I change this?".
 * Answering it by hand means a search for the symbol, a search for the file
 * name, a read of each result to see whether the hit was real, and a guess
 * about tests. That is a dozen calls and a lot of tokens.
 *
 * This does it in one, from the import graph the index already maintains, and
 * separates references into definitions, call sites, and tests — because those
 * three demand different responses from whoever is making the change.
 */

import { z } from 'zod';
import type { FileRecord } from '../core/code-index.js';
import type { CodeSymbol } from '../lang/types.js';
import { BudgetWriter } from '../core/tokens.js';
import { fields, FOOTER_RESERVE, footer, GLYPH, header, indent, plural } from '../core/render.js';
import { escapeRegExp, toLines, truncate } from '../util/text.js';
import { resolveBudget, tokenBudgetArg, type ToolContext } from './context.js';

export const traceSchema = {
  path: z.string().optional().describe('File to trace. Required unless a symbol is given that exists in only one file.'),
  symbol: z
    .string()
    .optional()
    .describe('Trace a specific symbol rather than the whole file, finding its references across the repository.'),
  direction: z
    .enum(['dependents', 'dependencies', 'both'])
    .optional()
    .describe('"dependents" (default): what would break. "dependencies": what this needs. "both": each in turn.'),
  depth: z.number().int().min(1).max(4).optional().describe('How many graph hops to follow. Default 1.'),
  tokenBudget: tokenBudgetArg,
};

type TraceArgs = {
  path?: string;
  symbol?: string;
  direction?: 'dependents' | 'dependencies' | 'both';
  depth?: number;
  tokenBudget?: number;
};

/** Reference sites shown per file before we assume the rest are alike. */
const MAX_REFS_PER_FILE = 4;

export async function runTrace(args: TraceArgs, ctx: ToolContext): Promise<string> {
  await ctx.index.ensureFresh();

  const budget = resolveBudget(ctx, args.tokenBudget);
  const direction = args.direction ?? 'dependents';
  const depth = args.depth ?? 1;

  const target = locate(args, ctx);
  if ('error' in target) return `jb_trace — ${target.error}`;

  const writer = new BudgetWriter(budget, FOOTER_RESERVE);
  writer.pushUnchecked(
    header(
      'jb_trace',
      fields(target.symbol ? `${target.symbol.name} in ${target.file.path}` : target.file.path, direction, `depth ${depth}`),
    ),
  );

  if (direction === 'dependents' || direction === 'both') {
    writer.pushUnchecked('');
    writer.pushUnchecked(`${GLYPH.edge} depended on by`);
    await renderDependents(target, ctx, writer, depth);
  }

  if (direction === 'dependencies' || direction === 'both') {
    writer.pushUnchecked('');
    writer.pushUnchecked(`${GLYPH.edge} depends on`);
    renderDependencies(target.file, ctx, writer, depth);
  }

  const notes = await ctx.notes.forPaths([target.file.path], 3);
  if (notes.length > 0) {
    writer.pushUnchecked('');
    writer.pushUnchecked('notes on this file');
    for (const note of notes) writer.push(indent(1, truncate(note.text, 160)));
  }

  writer.pushAllUnchecked(footer(writer, budget, 'jb_read {handle:"jb_…"} to inspect any reference site'));
  return writer.toString();
}

interface Target {
  file: FileRecord;
  symbol: CodeSymbol | undefined;
}

function locate(args: TraceArgs, ctx: ToolContext): Target | { error: string } {
  if (args.path) {
    const path = args.path.replace(/^\.?\/+/, '');
    const file = ctx.index.get(path);
    if (!file) return { error: `${path} is not indexed.` };

    if (!args.symbol) return { file, symbol: undefined };
    const symbol = file.symbols.find((s) => s.name === args.symbol) ?? file.symbols.find((s) => s.name.toLowerCase() === args.symbol!.toLowerCase());
    if (!symbol) return { error: `${path} declares no symbol "${args.symbol}".` };
    return { file, symbol };
  }

  if (!args.symbol) return { error: 'provide a path, a symbol, or both.' };

  // Symbol alone: unambiguous only if exactly one file declares it. Answered
  // from the symbol-name index rather than by scanning every file.
  const declaring = ctx.index
    .filesDeclaring(args.symbol)
    .map((file) => ({ file, symbol: file.symbols.find((s) => s.name === args.symbol) }))
    .filter((entry): entry is Target => entry.symbol !== undefined);

  if (declaring.length === 0) return { error: `no file declares a symbol named "${args.symbol}".` };
  if (declaring.length > 1) {
    const where = declaring.slice(0, 8).map((d) => d.file.path).join(', ');
    return { error: `"${args.symbol}" is declared in ${declaring.length} files (${where}). Pass path to disambiguate.` };
  }
  return declaring[0]!;
}

/**
 * Who depends on the target.
 *
 * For a file, that is the import graph. For a symbol, imports are necessary but
 * not sufficient — a file can import a module and never touch the symbol — so
 * we confirm by finding the actual reference lines.
 */
async function renderDependents(
  target: Target,
  ctx: ToolContext,
  writer: BudgetWriter,
  depth: number,
): Promise<void> {
  const levels = walkGraph(target.file, ctx, depth, 'dependents');

  if (levels.every((level) => level.length === 0)) {
    writer.push(indent(1, 'nothing in this workspace imports it'));
    return;
  }

  const matcher = target.symbol ? new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(target.symbol.name)}(?![A-Za-z0-9_$])`) : null;

  for (let hop = 0; hop < levels.length; hop++) {
    const level = levels[hop]!;
    if (level.length === 0) continue;
    if (depth > 1) writer.push(indent(1, `hop ${hop + 1} — ${plural(level.length, 'file')}`));

    for (const file of level) {
      const rowIndent = depth > 1 ? 2 : 1;
      const category = classify(file.path);

      if (!matcher || hop > 0) {
        const handle = ctx.handles.mint({
          path: file.path,
          startLine: 1,
          endLine: Math.max(1, file.lineCount),
          kind: 'file',
          label: file.path,
        });
        if (!writer.push(indent(rowIndent, fields(file.path, handle, file.language, category)))) return;
        continue;
      }

      // Direct dependents of a symbol: show where the name is actually used.
      const text = await ctx.workspace.readText(file.path, ctx.config.maxFileBytes);
      if (text === null) continue;
      const refs = findReferences(text, matcher, file);
      if (refs.length === 0) continue;

      if (!writer.push(indent(rowIndent, fields(file.path, plural(refs.length, 'reference'), category)))) return;

      for (const ref of refs.slice(0, MAX_REFS_PER_FILE)) {
        const handle = ctx.handles.mint(
          ref.symbol
            ? { path: file.path, startLine: ref.symbol.startLine, endLine: ref.symbol.endLine, kind: ref.symbol.kind, label: ref.symbol.name }
            : { path: file.path, startLine: ref.line, endLine: ref.line, kind: 'match', label: `${file.path}:${ref.line}` },
        );
        // Naming the enclosing symbol is the useful part; without one, the line
        // number alone suffices and printing it twice is waste.
        const row = ref.symbol
          ? fields(`${GLYPH.match} ${ref.symbol.name}`, handle, `:${ref.line}`)
          : fields(`${GLYPH.match} :${ref.line}`, handle);
        if (!writer.push(indent(rowIndent + 1, row))) return;
      }
      if (refs.length > MAX_REFS_PER_FILE) {
        writer.push(indent(rowIndent + 1, `… ${refs.length - MAX_REFS_PER_FILE} more`));
      }
    }
  }
}

function renderDependencies(file: FileRecord, ctx: ToolContext, writer: BudgetWriter, depth: number): void {
  const levels = walkGraph(file, ctx, depth, 'dependencies');
  const internal = levels.flat();

  if (internal.length === 0 && file.externals.length === 0) {
    writer.push(indent(1, 'no imports'));
    return;
  }

  for (const dependency of internal) {
    const handle = ctx.handles.mint({
      path: dependency.path,
      startLine: 1,
      endLine: Math.max(1, dependency.lineCount),
      kind: 'file',
      label: dependency.path,
    });
    if (!writer.push(indent(1, fields(dependency.path, handle, dependency.language)))) return;
  }

  if (file.externals.length > 0) {
    writer.push(indent(1, `external: ${file.externals.slice(0, 20).join(' ')}`));
  }
}

/** Breadth-first walk of the import graph, returning one array per hop. */
function walkGraph(
  start: FileRecord,
  ctx: ToolContext,
  depth: number,
  direction: 'dependents' | 'dependencies',
): FileRecord[][] {
  const levels: FileRecord[][] = [];
  const seen = new Set<number>([start.index]);
  let frontier = [start];

  for (let hop = 0; hop < depth; hop++) {
    const next: FileRecord[] = [];
    for (const file of frontier) {
      const neighbours = direction === 'dependents' ? file.dependents : file.dependencies;
      for (const index of neighbours) {
        if (seen.has(index)) continue;
        seen.add(index);
        const record = ctx.index.at(index);
        if (record) next.push(record);
      }
    }
    next.sort((a, b) => (a.path < b.path ? -1 : 1));
    levels.push(next);
    if (next.length === 0) break;
    frontier = next;
  }
  return levels;
}

interface Reference {
  line: number;
  symbol: CodeSymbol | undefined;
}

function findReferences(text: string, matcher: RegExp, file: FileRecord): Reference[] {
  const lines = toLines(text);
  const refs: Reference[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 500 || !matcher.test(line)) continue;
    // The import statement itself is not an interesting use site.
    if (file.imports.some((imp) => imp.line === i + 1)) continue;
    refs.push({ line: i + 1, symbol: enclosingSymbol(file.symbols, i + 1) });
  }
  return refs;
}

function enclosingSymbol(symbols: readonly CodeSymbol[], line: number): CodeSymbol | undefined {
  let best: CodeSymbol | undefined;
  for (const symbol of symbols) {
    if (line < symbol.startLine || line > symbol.endLine) continue;
    if (!best || symbol.depth > best.depth) best = symbol;
  }
  return best;
}

/**
 * Label a dependent by what kind of file it is. A change that breaks a test is
 * a different situation from one that breaks a public entrypoint.
 */
function classify(path: string): string | null {
  if (/(?:^|\/)(?:tests?|__tests__|spec)\//.test(path) || /\.(?:test|spec)\.[a-z]+$/.test(path) || /(?:^|\/)test_[^/]+\.py$/.test(path)) {
    return 'test';
  }
  if (/(?:^|\/)(?:examples?|samples?|docs?)\//.test(path)) return 'example';
  if (/(?:^|\/)(?:index|main|cli|app|server)\.[a-z]+$/.test(path)) return 'entrypoint';
  return null;
}
