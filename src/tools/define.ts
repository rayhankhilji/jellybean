/**
 * `jb_define` — where is this actually defined?
 *
 * Distinct from `jb_search mode:"symbol"`, which does fuzzy name matching and
 * returns a ranked list. This resolves, and the difference shows up when a name
 * is not unique. An agent reading `await store.load()` in one file, with five
 * `load` declarations across the repository, cannot tell from a ranked list
 * which one it is looking at. Given `from`, this follows that file's own import
 * statements and answers precisely.
 *
 * Guessing is the failure mode being designed out: when resolution is genuinely
 * ambiguous the tool says so and lists the candidates, rather than picking one
 * and letting the agent build on a wrong answer.
 */

import { z } from 'zod';
import type { FileRecord } from '../core/code-index.js';
import type { CodeSymbol } from '../lang/types.js';
import { BudgetWriter, clampTokens } from '../core/tokens.js';
import { fields, FOOTER_RESERVE, footer, GLYPH, header, indent, plural } from '../core/render.js';
import { toLines, truncate } from '../util/text.js';
import { resolveBudget, tokenBudgetArg, type ToolContext } from './context.js';

export const defineSchema = {
  symbol: z.string().min(1).describe('The name to resolve, exactly as it appears in the code.'),
  from: z
    .string()
    .optional()
    .describe(
      "The file where you saw the name used. This is what makes resolution precise rather than a guess — the file's own imports decide which definition is meant.",
    ),
  body: z
    .boolean()
    .optional()
    .describe('Include the definition source, not just its signature. Default false — the signature is usually enough.'),
  tokenBudget: tokenBudgetArg,
};

type DefineArgs = {
  symbol: string;
  from?: string;
  body?: boolean;
  tokenBudget?: number;
};

/** Candidates listed when resolution is ambiguous. */
const MAX_CANDIDATES = 10;
/** Re-export hops followed before giving up. Barrel files are rarely deeper. */
const MAX_REEXPORT_HOPS = 3;

interface Definition {
  file: FileRecord;
  symbol: CodeSymbol;
  /** How this was found, so the caller can judge how much to trust it. */
  via: string;
}

export async function runDefine(args: DefineArgs, ctx: ToolContext): Promise<string> {
  await ctx.index.ensureFresh();

  const budget = resolveBudget(ctx, args.tokenBudget);
  const name = args.symbol.trim();
  const from = args.from ? args.from.replace(/^\.?\/+/, '') : undefined;

  const resolution = resolve(name, from, ctx);

  const writer = new BudgetWriter(budget, FOOTER_RESERVE);

  if (resolution.definitions.length === 0) {
    writer.pushUnchecked(header('jb_define', fields(name, 'not found')));
    writer.pushUnchecked('');
    writer.pushUnchecked(
      from && !ctx.index.get(from)
        ? `${from} is not indexed, so its imports could not be consulted. Try without "from".`
        : `nothing declares "${name}". It may come from an external package, be constructed dynamically, or be spelled differently — try jb_search {query:"${truncate(name, 40)}", mode:"symbol"}.`,
    );
    return writer.toString();
  }

  const exact = resolution.definitions.length === 1;
  writer.pushUnchecked(
    header(
      'jb_define',
      fields(name, exact ? resolution.definitions[0]!.via : `${plural(resolution.definitions.length, 'candidate')} — ambiguous`),
    ),
  );
  writer.pushUnchecked('');

  if (!exact) {
    writer.pushUnchecked(
      from
        ? `${from} does not import "${name}", so which declaration is meant cannot be determined from imports alone.`
        : 'several files declare this name. Pass "from" — the file where you saw it used — to resolve it exactly.',
    );
    writer.pushUnchecked('');
  }

  for (const definition of resolution.definitions.slice(0, MAX_CANDIDATES)) {
    const handle = ctx.handles.mint({
      path: definition.file.path,
      startLine: definition.symbol.startLine,
      endLine: definition.symbol.endLine,
      kind: definition.symbol.kind,
      label: definition.symbol.name,
    });

    const row = fields(
      `${GLYPH.match} ${definition.file.path}:${definition.symbol.startLine}`,
      definition.symbol.kind,
      handle,
      definition.symbol.exported ? null : 'private',
      exact ? null : definition.via,
    );
    if (!writer.push(row)) break;
    if (!writer.push(indent(1, clampTokens(definition.symbol.signature, 60)))) break;
    if (definition.symbol.doc && !writer.push(indent(1, `— ${clampTokens(definition.symbol.doc, 40)}`))) break;
  }

  // Only worth reading the source when there is one answer to read.
  if (exact && (args.body ?? false)) {
    const definition = resolution.definitions[0]!;
    const text = await ctx.workspace.readText(definition.file.path, ctx.config.maxFileBytes);
    if (text !== null) {
      writer.pushUnchecked('');
      const lines = toLines(text).slice(definition.symbol.startLine - 1, definition.symbol.endLine);
      const width = String(definition.symbol.endLine).length;
      writer.pushAll(
        lines.map((line, i) => `${String(definition.symbol.startLine + i).padStart(width)}| ${line}`),
      );
    }
  }

  if (exact) {
    const definition = resolution.definitions[0]!;
    const dependents = definition.file.dependents.size;
    if (dependents > 0) {
      writer.push('');
      writer.push(`${plural(dependents, 'file')} import ${definition.file.path}`);
    }
  }

  writer.pushAllUnchecked(
    footer(
      writer,
      budget,
      exact
        ? `jb_define {symbol:"${name}", body:true} for the source, or jb_trace {symbol:"${name}"} for its callers`
        : 'pass from:"<the file using it>" to resolve exactly',
    ),
  );
  return writer.toString();
}

/**
 * Find the definition(s) a name refers to.
 *
 * Ordered by confidence, and it stops at the first level that gives a single
 * answer: an import in the using file is authoritative, a declaration in the
 * same file is next, and the repository-wide name index is the last resort.
 */
function resolve(name: string, from: string | undefined, ctx: ToolContext): { definitions: Definition[] } {
  const using = from ? ctx.index.get(from) : undefined;

  if (using) {
    // 1. An import naming it outright. This is the precise path.
    const viaImport = resolveThroughImports(name, using, ctx, MAX_REEXPORT_HOPS);
    if (viaImport) return { definitions: [viaImport] };

    // 2. Declared locally in the same file.
    const local = using.symbols.filter((symbol) => symbol.name === name);
    if (local.length > 0) {
      const best = local.sort((a, b) => a.depth - b.depth)[0]!;
      return { definitions: [{ file: using, symbol: best, via: 'declared in this file' }] };
    }
  }

  // 3. Anywhere in the workspace. Ambiguous unless exactly one file declares it.
  const declaring = ctx.index.filesDeclaring(name);
  const candidates: Definition[] = [];
  for (const file of declaring) {
    for (const symbol of file.symbols) {
      if (symbol.name !== name) continue;
      candidates.push({ file, symbol, via: symbol.exported ? 'exported' : 'not exported' });
    }
  }

  // An exported top-level declaration is a far likelier intent than a private
  // nested one, so surface those first rather than in path order.
  candidates.sort(
    (a, b) =>
      Number(b.symbol.exported) - Number(a.symbol.exported) ||
      a.symbol.depth - b.symbol.depth ||
      a.file.path.localeCompare(b.file.path),
  );
  return { definitions: candidates };
}

/**
 * Follow the using file's imports to the declaring file.
 *
 * Handles one common indirection: a barrel file that re-exports the symbol
 * rather than declaring it. Bounded, because a cycle of barrels would otherwise
 * loop forever.
 */
function resolveThroughImports(
  name: string,
  using: FileRecord,
  ctx: ToolContext,
  hops: number,
  seen = new Set<string>(),
): Definition | null {
  if (hops <= 0 || seen.has(using.path)) return null;
  seen.add(using.path);

  for (const ref of using.imports) {
    if (!ref.names.includes(name)) continue;

    const targetPath = ctx.index.resolveImport(using.path, ref.specifier);
    if (!targetPath) continue;
    const target = ctx.index.get(targetPath);
    if (!target) continue;

    const declared = target.symbols.filter((symbol) => symbol.name === name);
    if (declared.length > 0) {
      const best = declared.sort((a, b) => a.depth - b.depth)[0]!;
      return {
        file: target,
        symbol: best,
        via: using.path === target.path ? 'declared in this file' : `imported from ${ref.specifier}`,
      };
    }

    // The target does not declare it, so it is re-exporting from somewhere else.
    const deeper = resolveThroughImports(name, target, ctx, hops - 1, seen);
    if (deeper) return { ...deeper, via: `re-exported via ${targetPath}` };
  }
  return null;
}
