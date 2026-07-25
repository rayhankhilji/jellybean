/**
 * `jb_read` — read exactly the region you meant.
 *
 * The whole-file read is the default failure mode of agent tooling: an agent
 * wants one 20-line method and pays for 900 lines to get it. This tool accepts
 * a handle from any previous result, a symbol name, or an explicit line range,
 * and returns just that.
 *
 * `mode:"skeleton"` is the escape hatch for when you genuinely do want the whole
 * file: it keeps every declaration and elides function bodies, which typically
 * costs a fifth of the source and answers structural questions just as well.
 */

import { z } from 'zod';
import type { FileRecord } from '../core/code-index.js';
import type { CodeSymbol } from '../lang/types.js';
import { isHandle } from '../core/handles.js';
import { BudgetWriter } from '../core/tokens.js';
import { fields, FOOTER_RESERVE, footer, header, numberedLines, plural, span } from '../core/render.js';
import { toLines } from '../util/text.js';
import { resolveBudget, tokenBudgetArg, type ToolContext } from './context.js';

export const readSchema = {
  handle: z.string().optional().describe('A handle from a previous result, e.g. "jb_3f9a21c4". Cheapest way to read.'),
  path: z.string().optional().describe('File to read, relative to the workspace root. Ignored when a handle is given.'),
  symbol: z
    .string()
    .optional()
    .describe('Read only this symbol from the file, by name. Use "Class.method" to disambiguate.'),
  lines: z.string().optional().describe('Explicit 1-based inclusive range, e.g. "40-120" or "57".'),
  context: z
    .number()
    .int()
    .min(0)
    .max(200)
    .optional()
    .describe('Extra lines to include on each side of the region. Default 0.'),
  mode: z
    .enum(['source', 'skeleton'])
    .optional()
    .describe('"source" (default) returns the region verbatim. "skeleton" returns declarations with bodies elided.'),
  tokenBudget: tokenBudgetArg,
};

type ReadArgs = {
  handle?: string;
  path?: string;
  symbol?: string;
  lines?: string;
  context?: number;
  mode?: 'source' | 'skeleton';
  tokenBudget?: number;
};

export async function runRead(args: ReadArgs, ctx: ToolContext): Promise<string> {
  await ctx.index.ensureFresh();

  const budget = resolveBudget(ctx, args.tokenBudget);
  const region = resolveRegion(args, ctx);
  if ('error' in region) return `jb_read — ${region.error}`;

  const { path, startLine, endLine, label } = region;
  const text = await ctx.workspace.readText(path, ctx.config.maxFileBytes);
  if (text === null) {
    return `jb_read — cannot read ${path}. It may be binary, missing, or larger than the ${ctx.config.maxFileBytes}-byte limit.`;
  }

  const file = ctx.index.get(path);
  const allLines = toLines(text);
  const context = args.context ?? 0;

  const from = Math.max(1, startLine - context);
  const to = Math.min(allLines.length, endLine + context);

  const writer = new BudgetWriter(budget, FOOTER_RESERVE);
  const mode = args.mode ?? 'source';

  writer.pushUnchecked(
    header(
      'jb_read',
      fields(
        span(path, from, to),
        label,
        file?.language,
        mode === 'skeleton' ? 'skeleton' : null,
        `of ${plural(allLines.length, 'line')}`,
      ),
    ),
  );
  writer.pushUnchecked('');

  const body =
    mode === 'skeleton'
      ? skeletonLines(allLines, file?.symbols ?? [], from, to)
      : numberedLines(allLines.slice(from - 1, to), from);

  writer.pushAll(body);

  const hint =
    writer.omitted > 0
      ? `the region is larger than the budget — call again with lines:"${from}-${Math.min(to, from + 150)}" or mode:"skeleton"`
      : 'jb_trace {path:"' + path + '"} to see what depends on this';
  writer.pushAllUnchecked(footer(writer, budget, hint));
  return writer.toString();
}

interface Region {
  path: string;
  startLine: number;
  endLine: number;
  label: string | null;
}

function resolveRegion(args: ReadArgs, ctx: ToolContext): Region | { error: string } {
  if (args.handle) {
    if (!isHandle(args.handle)) {
      return { error: `"${args.handle}" is not a handle. Handles look like jb_3f9a21c4.` };
    }
    const target = ctx.handles.get(args.handle);
    if (!target) {
      return {
        error: `handle ${args.handle} has expired. Re-run the search or outline that produced it, or pass path directly.`,
      };
    }
    return { path: target.path, startLine: target.startLine, endLine: target.endLine, label: target.label };
  }

  if (!args.path) return { error: 'provide either a handle or a path.' };

  const path = args.path.replace(/^\.?\/+/, '');
  const file = ctx.index.get(path);

  if (args.symbol) {
    if (!file) return { error: `${path} is not indexed, so its symbols are unknown.` };
    const symbol = findSymbol(file, args.symbol);
    if (!symbol) {
      const available = file.symbols
        .filter((s) => s.depth === 0)
        .slice(0, 15)
        .map((s) => s.name)
        .join(', ');
      return { error: `${path} has no symbol "${args.symbol}". Top-level symbols: ${available || 'none found'}.` };
    }
    return { path, startLine: symbol.startLine, endLine: symbol.endLine, label: `${symbol.name} (${symbol.kind})` };
  }

  if (args.lines) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(args.lines.trim());
    if (!m) return { error: `cannot parse lines:"${args.lines}". Use "40-120" or "57".` };
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    if (end < start) return { error: `lines:"${args.lines}" ends before it starts.` };
    return { path, startLine: start, endLine: end, label: null };
  }

  return { path, startLine: 1, endLine: file?.lineCount ?? Number.MAX_SAFE_INTEGER, label: null };
}

/** Resolve `name` or `Container.name`, preferring top-level and exported matches. */
function findSymbol(file: FileRecord, query: string): CodeSymbol | undefined {
  const [containerName, memberName] = query.includes('.') ? query.split('.', 2) : [undefined, query];
  const wanted = (memberName ?? query).toLowerCase();

  const candidates = file.symbols.filter((s) => s.name.toLowerCase() === wanted);
  if (candidates.length === 0) return undefined;
  if (!containerName) {
    return candidates.sort((a, b) => a.depth - b.depth || Number(b.exported) - Number(a.exported))[0];
  }

  const container = file.symbols.find((s) => s.name.toLowerCase() === containerName.toLowerCase());
  if (!container) return candidates[0];
  return (
    candidates.find((s) => s.startLine >= container.startLine && s.endLine <= container.endLine) ?? candidates[0]
  );
}

/**
 * Render a range with function bodies replaced by a line count.
 *
 * Class and module bodies are kept, because their contents *are* the structure.
 * Only leaf executable bodies are elided, and only when eliding actually saves
 * something — collapsing a three-line function into a one-line marker is churn.
 */
function skeletonLines(
  allLines: readonly string[],
  symbols: readonly CodeSymbol[],
  from: number,
  to: number,
): string[] {
  const ELIDABLE = new Set(['function', 'method']);
  const MIN_ELIDABLE_BODY = 4;

  const ranges: Array<[number, number]> = [];
  for (const symbol of symbols) {
    if (!ELIDABLE.has(symbol.kind)) continue;
    const bodyStart = symbol.startLine + 1;
    const bodyEnd = symbol.endLine - 1;
    if (bodyEnd - bodyStart + 1 < MIN_ELIDABLE_BODY) continue;
    ranges.push([bodyStart, bodyEnd]);
  }
  ranges.sort((a, b) => a[0] - b[0]);

  // Merge overlaps so a nested function inside an elided body is not counted twice.
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }

  const width = String(to).length;
  const out: string[] = [];

  for (let line = from; line <= to; line++) {
    const hidden = merged.find(([start, end]) => line >= start && line <= end);
    if (hidden) {
      if (line === hidden[0]) {
        const count = Math.min(hidden[1], to) - line + 1;
        out.push(`${' '.repeat(width)}| … ${count} lines`);
      }
      continue;
    }
    out.push(`${String(line).padStart(width)}| ${allLines[line - 1] ?? ''}`);
  }
  return out;
}
