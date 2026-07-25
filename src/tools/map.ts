/**
 * `jb_map` — the orientation tool.
 *
 * The first question an agent has about an unfamiliar repository is "what is
 * here and what matters?". The expensive way to answer is to list every file
 * and read the interesting ones. This answers it in one call, within a budget,
 * ordered by structural importance rather than alphabetically — because the
 * files everything imports are the ones worth seeing first.
 */

import { z } from 'zod';
import type { FileRecord } from '../core/code-index.js';
import { BudgetWriter } from '../core/tokens.js';
import { fields, FOOTER_RESERVE, footer, GLYPH, header, indent, plural, tally } from '../core/render.js';
import { readProjectName } from '../diagnostics/runner.js';
import { resolveBudget, tokenBudgetArg, type ToolContext } from './context.js';

export const mapSchema = {
  path: z
    .string()
    .optional()
    .describe('Restrict the map to a subdirectory, e.g. "src/core". Omit for the whole repository.'),
  depth: z
    .enum(['tree', 'files', 'symbols'])
    .optional()
    .describe(
      'How much to show. "tree": directories and counts only (cheapest). "files": one row per file (default). "symbols": each file plus its top-level symbols.',
    ),
  focus: z
    .string()
    .optional()
    .describe('Rank files by relevance to this topic instead of by structural importance.'),
  tokenBudget: tokenBudgetArg,
};

type MapArgs = {
  path?: string;
  depth?: 'tree' | 'files' | 'symbols';
  focus?: string;
  tokenBudget?: number;
};

export async function runMap(args: MapArgs, ctx: ToolContext): Promise<string> {
  await ctx.index.ensureFresh();

  const budget = resolveBudget(ctx, args.tokenBudget);
  const depth = args.depth ?? 'files';
  const prefix = normalizePrefix(args.path);

  const files = ctx.index.all().filter((file) => prefix === '' || file.path.startsWith(prefix));
  if (files.length === 0) {
    return `jb_map — no indexed files${prefix ? ` under ${prefix}` : ''}. The path may be ignored by .gitignore.`;
  }

  const writer = new BudgetWriter(budget, FOOTER_RESERVE);
  const projectName = await readProjectName(ctx.workspace);

  const languages = new Map<string, number>();
  let totalLines = 0;
  for (const file of files) {
    languages.set(file.language, (languages.get(file.language) ?? 0) + 1);
    totalLines += file.lineCount;
  }

  writer.pushUnchecked(
    header(
      'jb_map',
      fields(
        projectName ?? ctx.workspace.root.slice(ctx.workspace.root.lastIndexOf('/') + 1),
        prefix ? `under ${prefix}` : null,
        plural(files.length, 'file'),
        `${formatCount(totalLines)} lines`,
        tally(languages),
      ),
    ),
  );
  writer.pushUnchecked('');

  if (depth === 'tree') {
    renderTree(files, writer, prefix);
  } else {
    renderFiles(files, writer, ctx, depth === 'symbols', args.focus);
  }

  const hint =
    depth === 'tree'
      ? 'jb_map {path:"<dir>", depth:"symbols"} to see what a directory contains'
      : 'jb_outline {path:"<file>"} for a file\'s full structure, or jb_read {handle:"jb_…"}';
  writer.pushAllUnchecked(footer(writer, budget, hint));
  return writer.toString();
}

function normalizePrefix(path: string | undefined): string {
  if (!path) return '';
  const cleaned = path.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  return cleaned === '' || cleaned === '.' ? '' : cleaned + '/';
}

/** Directory rollup: the cheapest possible orientation. */
function renderTree(files: readonly FileRecord[], writer: BudgetWriter, prefix: string): void {
  interface Node {
    files: number;
    lines: number;
    languages: Map<string, number>;
  }
  const directories = new Map<string, Node>();

  const nodeFor = (dir: string): Node => {
    let node = directories.get(dir);
    if (!node) {
      node = { files: 0, lines: 0, languages: new Map() };
      directories.set(dir, node);
    }
    return node;
  };

  for (const file of files) {
    const rest = file.path.slice(prefix.length);
    const slash = rest.lastIndexOf('/');
    const dir = slash === -1 ? '.' : rest.slice(0, slash);

    const node = nodeFor(dir);
    node.files++;
    node.lines += file.lineCount;
    node.languages.set(file.language, (node.languages.get(file.language) ?? 0) + 1);

    // Ensure every ancestor exists. A directory holding only other directories
    // has no files of its own, but omitting it would leave its children indented
    // under nothing.
    if (dir === '.') continue;
    const segments = dir.split('/');
    for (let i = 1; i < segments.length; i++) nodeFor(segments.slice(0, i).join('/'));
  }

  const sorted = [...directories.keys()].sort();
  for (const dir of sorted) {
    const node = directories.get(dir)!;
    const segments = dir === '.' ? [] : dir.split('/');
    // Indentation already conveys the ancestry, so only the final segment is
    // printed — repeating the full path on every row is the expensive way to
    // draw a tree.
    const label = segments.length === 0 ? './' : `${segments[segments.length - 1]}/`;
    const detail =
      node.files === 0
        ? null
        : fields(plural(node.files, 'file'), `${formatCount(node.lines)}L`, tally(node.languages, 3));
    if (!writer.push(indent(segments.length, fields(label, detail)))) return;
  }
}

/**
 * One row per file, optionally with each file's top-level symbols.
 *
 * Files are grouped under a directory header so a path prefix is written once
 * instead of once per row — on a deep tree that alone is a double-digit
 * percentage of the result. Directories are ordered by their best-ranked file,
 * which keeps the grouping from fighting the ranking.
 */
function renderFiles(
  files: readonly FileRecord[],
  writer: BudgetWriter,
  ctx: ToolContext,
  withSymbols: boolean,
  focus: string | undefined,
): void {
  const scores = scoreFiles(files, ctx, focus);
  const groups = new Map<string, FileRecord[]>();

  for (const file of files) {
    const slash = file.path.lastIndexOf('/');
    const directory = slash === -1 ? '.' : file.path.slice(0, slash);
    const bucket = groups.get(directory);
    if (bucket) bucket.push(file);
    else groups.set(directory, [file]);
  }

  const best = (group: readonly FileRecord[]): number =>
    group.reduce((max, file) => Math.max(max, scores.get(file.path) ?? 0), -Infinity);

  const ordered = [...groups.entries()].sort((a, b) => best(b[1]) - best(a[1]) || (a[0] < b[0] ? -1 : 1));

  for (const [directory, group] of ordered) {
    if (!writer.push(`${directory}/`)) return;

    group.sort((a, b) => (scores.get(b.path) ?? 0) - (scores.get(a.path) ?? 0) || (a.path < b.path ? -1 : 1));

    for (const file of group) {
      const handle = ctx.handles.mint({
        path: file.path,
        startLine: 1,
        endLine: Math.max(1, file.lineCount),
        kind: 'file',
        label: file.path,
      });

      const name = file.path.slice(file.path.lastIndexOf('/') + 1);
      const links = file.dependents.size > 0 ? `←${file.dependents.size}` : null;
      const row = fields(
        indent(1, `${GLYPH.file} ${name}`),
        handle,
        file.skipped ? 'unparsed' : `${file.lineCount}L`,
        file.language,
        links,
        file.skipped ? null : file.symbols.length > 0 ? `${file.symbols.length}sym` : null,
      );
      if (!writer.push(row)) return;

      if (!withSymbols) continue;

      for (const symbol of file.symbols.filter((s) => s.depth === 0).slice(0, 12)) {
        const line = indent(2, fields(`${GLYPH.symbol} ${symbol.name}`, symbol.kind, `:${symbol.startLine}`));
        if (!writer.push(line)) return;
      }
    }
  }
}

/**
 * Score files for display order.
 *
 * Without a focus, by structural importance — what depends on what. With one,
 * relevance dominates and importance breaks ties, so `focus:"authentication"`
 * surfaces the auth files even when nothing imports them.
 */
function scoreFiles(
  files: readonly FileRecord[],
  ctx: ToolContext,
  focus: string | undefined,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const file of files) scores.set(file.path, ctx.index.importance(file));

  if (focus && focus.trim() !== '') {
    const hits = ctx.index.searchFiles(focus, 400);
    const best = hits[0]?.score ?? 1;
    for (const hit of hits) {
      const current = scores.get(hit.file.path);
      if (current === undefined) continue;
      scores.set(hit.file.path, current + (hit.score / best) * 20);
    }
  }
  return scores;
}

function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}
