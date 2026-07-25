/**
 * `jb_outline` — a file's structure without its bodies.
 *
 * This is the single biggest token saving Jelly Bean offers. A 900-line service
 * class costs roughly 9,000 tokens to read; its outline costs about 300 and
 * answers most questions an agent actually has ("is there already a method for
 * this?", "what does this class expose?", "where do I add the new branch?").
 *
 * Every symbol carries a handle, so the two or three that matter can be read in
 * full without paying for the other forty.
 */

import { z } from 'zod';
import type { CodeSymbol } from '../lang/types.js';
import { BudgetWriter, clampTokens } from '../core/tokens.js';
import { fields, FOOTER_RESERVE, footer, header, indent, plural } from '../core/render.js';
import { resolveBudget, tokenBudgetArg, type ToolContext } from './context.js';

export const outlineSchema = {
  path: z.string().describe('File or directory to outline, relative to the workspace root.'),
  includePrivate: z
    .boolean()
    .optional()
    .describe('Include non-exported symbols. Default true for a single file, false for a directory.'),
  signatures: z
    .boolean()
    .optional()
    .describe('Show full declaration signatures rather than names alone. Default true.'),
  maxDepth: z
    .number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe('Deepest nesting level to include. 0 shows only top-level symbols.'),
  tokenBudget: tokenBudgetArg,
};

type OutlineArgs = {
  path: string;
  includePrivate?: boolean;
  signatures?: boolean;
  maxDepth?: number;
  tokenBudget?: number;
};

export async function runOutline(args: OutlineArgs, ctx: ToolContext): Promise<string> {
  await ctx.index.ensureFresh();

  const budget = resolveBudget(ctx, args.tokenBudget);
  const kind = await ctx.workspace.kindOf(args.path);
  if (kind === 'missing') {
    return `jb_outline — no such path: ${args.path}`;
  }

  const isDirectory = kind === 'directory';
  const showSignatures = args.signatures ?? true;
  const includePrivate = args.includePrivate ?? !isDirectory;
  const maxDepth = args.maxDepth ?? 5;

  const prefix = args.path.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  const files = isDirectory
    ? ctx.index.all().filter((f) => prefix === '' || f.path.startsWith(prefix + '/'))
    : [ctx.index.get(prefix)].filter((f): f is NonNullable<typeof f> => f !== undefined);

  if (files.length === 0) {
    return `jb_outline — ${args.path} is not indexed. It may be ignored, binary, or larger than the configured limit.`;
  }

  const writer = new BudgetWriter(budget, FOOTER_RESERVE);
  const totalSymbols = files.reduce((sum, f) => sum + f.symbols.length, 0);

  writer.pushUnchecked(
    header(
      'jb_outline',
      fields(
        prefix || '.',
        plural(files.length, 'file'),
        plural(totalSymbols, 'symbol'),
        includePrivate ? null : 'exported only',
      ),
    ),
  );

  for (const file of files) {
    const visible = file.symbols.filter((s) => s.depth <= maxDepth && (includePrivate || s.exported));
    if (visible.length === 0 && isDirectory) continue;

    writer.pushUnchecked('');
    if (!writer.push(fields(file.path, `${file.lineCount}L`, file.language, plural(visible.length, 'symbol')))) break;

    if (visible.length === 0) {
      writer.push(indent(1, file.skipped ? '(not parsed)' : '(no symbols found)'));
      continue;
    }

    let exhausted = false;
    for (const symbol of visible) {
      // Properties are not worth a handle: reading one field in isolation tells
      // you nothing you cannot already see in the signature printed here.
      const handle =
        symbol.kind === 'property'
          ? null
          : ctx.handles.mint({
              path: file.path,
              startLine: symbol.startLine,
              endLine: symbol.endLine,
              kind: symbol.kind,
              label: symbol.name,
            });
      if (!writer.push(renderSymbol(symbol, handle, showSignatures))) {
        exhausted = true;
        break;
      }
    }
    if (exhausted) break;
  }

  writer.pushAllUnchecked(
    footer(writer, budget, 'jb_read {handle:"jb_…"} to read one symbol\'s body, or jb_trace to see its callers'),
  );
  return writer.toString();
}

function renderSymbol(symbol: CodeSymbol, handle: string | null, showSignatures: boolean): string {
  const lines = symbol.endLine > symbol.startLine ? `${symbol.startLine}-${symbol.endLine}` : `${symbol.startLine}`;

  // A signature already contains the name and the kind is implied by the
  // keyword, so printing all three would be paying twice for the same fact.
  const label = showSignatures ? clampTokens(symbol.signature, 40) : `${symbol.name} (${symbol.kind})`;

  return indent(symbol.depth + 1, fields(label, handle, `:${lines}`, symbol.exported ? null : 'private'));
}
