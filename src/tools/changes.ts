/**
 * `jb_changes` — what have I changed, and what might it break?
 *
 * The pre-pull-request question, and the one that raw `git diff` answers most
 * expensively: a thousand lines of diff to discover that three functions were
 * touched. This maps changed line ranges onto the symbols that contain them, so
 * the answer is "you changed `retryWithBackoff` and `Store.load`" — and then,
 * because the import graph is already built, what depends on each of them.
 *
 * That combination is the point. A diff tells you what you typed; this tells
 * you what you affected.
 */

import { z } from 'zod';
import type { FileRecord } from '../core/code-index.js';
import type { CodeSymbol } from '../lang/types.js';
import { BudgetWriter } from '../core/tokens.js';
import { fields, FOOTER_RESERVE, footer, GLYPH, header, indent, plural } from '../core/render.js';
import { changedFiles, currentBranch, defaultBase, isRepository, type ChangedFile } from '../core/git.js';
import { resolveBudget, tokenBudgetArg, type ToolContext } from './context.js';

export const changesSchema = {
  scope: z
    .enum(['working', 'branch'])
    .optional()
    .describe(
      '"working" (default): uncommitted work, staged or not, plus untracked files. "branch": every change on this branch versus its base.',
    ),
  base: z
    .string()
    .optional()
    .describe('Branch or ref to compare against when scope is "branch". Defaults to origin/main, main, or master.'),
  impact: z
    .boolean()
    .optional()
    .describe('For each changed symbol, list what depends on it. Default true — this is usually why you are asking.'),
  path: z.string().optional().describe('Restrict to a subdirectory.'),
  tokenBudget: tokenBudgetArg,
};

type ChangesArgs = {
  scope?: 'working' | 'branch';
  base?: string;
  impact?: boolean;
  path?: string;
  tokenBudget?: number;
};

/** Dependents listed per changed symbol before the list stops being scannable. */
const MAX_IMPACT_PER_SYMBOL = 5;

export async function runChanges(args: ChangesArgs, ctx: ToolContext): Promise<string> {
  const budget = resolveBudget(ctx, args.tokenBudget);

  if (!(await isRepository(ctx.workspace.root))) {
    return 'jb_changes — not a git repository, so there is nothing to compare against.';
  }
  await ctx.index.ensureFresh();

  const scope = args.scope ?? 'working';
  let base: string | null = null;

  if (scope === 'branch') {
    base = args.base ?? (await defaultBase(ctx.workspace.root));
    if (!base) {
      return 'jb_changes — could not find a base branch to compare against. Pass base:"<ref>" explicitly.';
    }
  }

  const prefix = args.path ? args.path.replace(/^\.?\/+/, '').replace(/\/+$/, '') + '/' : '';
  const changed = (await changedFiles(ctx.workspace.root, base)).filter(
    (file) => prefix === '' || file.path.startsWith(prefix),
  );

  const writer = new BudgetWriter(budget, FOOTER_RESERVE);
  const branch = await currentBranch(ctx.workspace.root);
  const totalAdded = changed.reduce((sum, f) => sum + f.added, 0);
  const totalRemoved = changed.reduce((sum, f) => sum + f.removed, 0);

  writer.pushUnchecked(
    header(
      'jb_changes',
      fields(
        scope === 'branch' ? `${branch ?? 'HEAD'} vs ${base}` : 'uncommitted',
        plural(changed.length, 'file'),
        `+${totalAdded}/-${totalRemoved}`,
      ),
    ),
  );

  if (changed.length === 0) {
    writer.pushUnchecked('');
    writer.pushUnchecked(
      scope === 'branch' ? 'this branch is identical to its base.' : 'the working tree is clean.',
    );
    return writer.toString();
  }

  const showImpact = args.impact ?? true;

  for (const file of changed) {
    const record = ctx.index.get(file.path);

    // An untracked file has no diff, because git has never seen it. All of it is
    // new, so its line count is its change count.
    const wholeFile = file.status === 'untracked' || file.status === 'added';
    if (wholeFile && record && file.added === 0) file.added = record.lineCount;

    writer.pushUnchecked('');
    if (!writer.push(fields(file.path, file.status, `+${file.added}/-${file.removed}`, record?.language))) break;

    if (file.status === 'deleted') {
      if (!renderDeletedImpact(file, ctx, writer, showImpact)) break;
      continue;
    }

    if (!record || record.symbols.length === 0) {
      // No outline — either an unparsed language or a brand-new file the index
      // has not caught up with. The line ranges are still worth reporting.
      if (file.ranges.length > 0) {
        writer.push(indent(1, `lines ${file.ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(' ')}`));
      }
      continue;
    }

    // For a wholly new file, every symbol is "touched" — but listing every
    // method of every class is noise. Its top-level shape is the useful answer.
    const touched = wholeFile
      ? record.symbols.filter((symbol) => symbol.depth === 0)
      : touchedSymbols(record, file);

    if (touched.length === 0) {
      writer.push(indent(1, 'changes fall outside any symbol (imports, top-level statements, or comments)'));
      continue;
    }

    let exhausted = false;
    for (const symbol of touched) {
      const handle = ctx.handles.mint({
        path: file.path,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        kind: symbol.kind,
        label: symbol.name,
      });
      if (!writer.push(indent(1, fields(`${GLYPH.symbol} ${symbol.name}`, symbol.kind, handle, `:${symbol.startLine}`)))) {
        exhausted = true;
        break;
      }
    }
    if (exhausted) break;

    // Dependents come from the import graph, which is file-level. Printing them
    // under each symbol would imply a per-symbol precision we do not have.
    if (showImpact && touched.some((symbol) => symbol.exported) && !renderImpact(record, ctx, writer)) break;
  }

  writer.pushAllUnchecked(
    footer(
      writer,
      budget,
      'jb_read {handle:"jb_…"} to review a changed symbol, or jb_trace for its full dependency graph',
    ),
  );
  return writer.toString();
}

/** Symbols whose extent overlaps any changed range, innermost first. */
function touchedSymbols(record: FileRecord, file: ChangedFile): CodeSymbol[] {
  const touched = new Map<string, CodeSymbol>();

  for (const [from, to] of file.ranges) {
    for (const symbol of record.symbols) {
      if (symbol.endLine < from || symbol.startLine > to) continue;
      const key = `${symbol.startLine}:${symbol.name}`;
      const existing = touched.get(key);
      // Prefer the most deeply nested symbol containing the change: "you changed
      // Store.load" is more useful than "you changed Store".
      if (!existing || symbol.depth > existing.depth) touched.set(key, symbol);
    }
  }

  // Drop containers that are only present because a member of theirs changed.
  const all = [...touched.values()];
  const specific = all.filter(
    (symbol) => !all.some((other) => other !== symbol && other.startLine >= symbol.startLine && other.endLine <= symbol.endLine),
  );
  return (specific.length > 0 ? specific : all).sort((a, b) => a.startLine - b.startLine);
}

/**
 * What depends on the changed file.
 *
 * Reported per file rather than per symbol because the import graph records
 * which files import which — not which symbol each import was for. Attributing
 * it to individual symbols would overstate what we actually know.
 */
function renderImpact(record: FileRecord, ctx: ToolContext, writer: BudgetWriter): boolean {
  const dependents: string[] = [];
  for (const index of record.dependents) {
    const dependent = ctx.index.at(index);
    if (dependent) dependents.push(dependent.path);
  }

  if (dependents.length === 0) return true;
  dependents.sort();

  const shown = dependents.slice(0, MAX_IMPACT_PER_SYMBOL);
  const suffix = dependents.length > shown.length ? ` +${dependents.length - shown.length} more` : '';
  return writer.push(indent(2, `${GLYPH.edge} used by ${shown.join(' ')}${suffix}`));
}

/** A deleted file's dependents are the highest-value thing to report about it. */
function renderDeletedImpact(file: ChangedFile, ctx: ToolContext, writer: BudgetWriter, showImpact: boolean): boolean {
  if (!showImpact) return true;

  // The record may still be in the index if the scan has not caught up, which is
  // precisely when this warning is most useful.
  const record = ctx.index.get(file.path);
  if (!record || record.dependents.size === 0) return true;

  const dependents = [...record.dependents]
    .map((index) => ctx.index.at(index)?.path)
    .filter((path): path is string => path !== undefined)
    .sort();

  const shown = dependents.slice(0, MAX_IMPACT_PER_SYMBOL);
  const suffix = dependents.length > shown.length ? ` +${dependents.length - shown.length} more` : '';
  return writer.push(indent(1, `${GLYPH.warn} still imported by ${shown.join(' ')}${suffix}`));
}
