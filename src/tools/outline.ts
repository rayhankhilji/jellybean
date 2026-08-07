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
import { BudgetWriter, clampTokens, estimateTokens } from '../core/tokens.js';
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

    // Pick a detail level that fits rather than writing rich rows until the
    // budget runs out. Dropping a symbol hides its existence; dropping its
    // signature only hides its shape, and an agent that knows a method exists
    // can always ask for it. Detail is the cheaper thing to lose.
    const detail = chooseDetail(visible, writer.remaining, showSignatures);

    if (detail === 'packed') {
      // No handles at this level: at ~6 tokens each they cost more than the
      // names they point at, and a name is enough to ask a follow-up with.
      writer.pushAll(packSymbols(visible));
      if (writer.isFull) break;
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
      if (!writer.push(renderSymbol(symbol, handle, detail === 'full'))) {
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

/** How much is shown per symbol. Chosen to fit, in this order of preference. */
type Detail = 'full' | 'named' | 'packed';

/** A handle is about this many tokens; enough to matter when there are fifty. */
const HANDLE_TOKENS = 6;

/**
 * The most detail that fits the remaining budget.
 *
 * Measured rather than guessed, because "will fifty rows fit" depends entirely
 * on how long the signatures are, and a class of one-line getters is a very
 * different proposition from a class of generic factory methods.
 */
function chooseDetail(symbols: readonly CodeSymbol[], remaining: number, showSignatures: boolean): Detail {
  if (showSignatures && cost(symbols, 'full') <= remaining) return 'full';
  if (cost(symbols, 'named') <= remaining) return 'named';
  return 'packed';
}

function cost(symbols: readonly CodeSymbol[], detail: Exclude<Detail, 'packed'>): number {
  let total = 0;
  for (const symbol of symbols) {
    const label = detail === 'full' ? clampTokens(symbol.signature, 40) : `${symbol.name} (${symbol.kind})`;
    total += estimateTokens(label) + HANDLE_TOKENS + LINE_REF_TOKENS;
  }
  return total;
}

/** `:31-367` and the surrounding separators, roughly. */
const LINE_REF_TOKENS = 5;

/** Symbols per line when packed. Long enough to be dense, short enough to read. */
const PACKED_PER_LINE = 6;

/**
 * Names only, grouped by kind, several to a line.
 *
 * The last resort before dropping symbols outright. It answers "what is in this
 * file" completely, at roughly a fifth of the cost of the full rows, and leaves
 * the agent able to name anything it wants to look at more closely.
 */
function packSymbols(symbols: readonly CodeSymbol[]): string[] {
  // Deduplicated, because a name-only listing repeating `moduleRef` five times
  // says nothing the first one did not. The full rows keep every occurrence,
  // where the line numbers make them distinct.
  const byKind = new Map<string, Set<string>>();
  for (const symbol of symbols) {
    const bucket = byKind.get(symbol.kind);
    if (bucket) bucket.add(symbol.name);
    else byKind.set(symbol.kind, new Set([symbol.name]));
  }

  const rows: string[] = [];
  for (const [kind, unique] of byKind) {
    const names = [...unique];
    for (let i = 0; i < names.length; i += PACKED_PER_LINE) {
      const chunk = names.slice(i, i + PACKED_PER_LINE).join(', ');
      rows.push(indent(1, i === 0 ? `${plural(names.length, kind, pluralKind(kind))}: ${chunk}` : `  ${chunk}`));
    }
  }
  return rows;
}

/** English plurals for the symbol kinds whose default `+s` is wrong. */
function pluralKind(kind: string): string {
  if (kind.endsWith('y')) return `${kind.slice(0, -1)}ies`; // property -> properties
  if (kind.endsWith('s') || kind.endsWith('ch') || kind.endsWith('x')) return `${kind}es`;
  return `${kind}s`;
}

function renderSymbol(symbol: CodeSymbol, handle: string | null, showSignatures: boolean): string {
  const lines = symbol.endLine > symbol.startLine ? `${symbol.startLine}-${symbol.endLine}` : `${symbol.startLine}`;

  // A signature already contains the name and the kind is implied by the
  // keyword, so printing all three would be paying twice for the same fact.
  const label = showSignatures ? clampTokens(symbol.signature, 40) : `${symbol.name} (${symbol.kind})`;

  return indent(symbol.depth + 1, fields(label, handle, `:${lines}`, symbol.exported ? null : 'private'));
}
