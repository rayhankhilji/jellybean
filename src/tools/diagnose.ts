/**
 * `jb_diagnose` — run a project check and return the problems, not the log.
 *
 * This is the autonomy tool. An agent that can run the test suite, get back
 * eleven deduplicated failures each anchored to a file and line with the
 * relevant source already attached, and fix them, does not need a human in the
 * loop for the boring half of debugging.
 *
 * Security: commands are never passed to a shell. See runner.ts. With no
 * arguments the tool lists what it is willing to run, which is also how an
 * agent discovers a project's checks without reading its manifests.
 */

import { z } from 'zod';
import { BudgetWriter, clampTokens } from '../core/tokens.js';
import type { HandleTarget } from '../core/handles.js';
import { fields, FOOTER_RESERVE, footer, GLYPH, header, indent, numberedLines, plural } from '../core/render.js';
import { discoverChecks, run, splitCommand, type Check } from '../diagnostics/runner.js';
import { parseDiagnostics, type Diagnostic } from '../diagnostics/parsers.js';
import { toLines, truncate } from '../util/text.js';
import { resolveBudget, tokenBudgetArg, type ToolContext } from './context.js';

export const diagnoseSchema = {
  check: z
    .string()
    .optional()
    .describe('Name of a project check to run, as listed by calling this tool with no arguments (e.g. "test", "make:lint").'),
  command: z
    .string()
    .optional()
    .describe('An explicit command. Only permitted when the server was started with --allow-command or --unsafe-commands.'),
  contextLines: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe('Lines of source to show around each located problem. Default 2. Set 0 for the list alone.'),
  maxProblems: z.number().int().min(1).max(100).optional().describe('How many distinct problems to report. Default 15.'),
  includeWarnings: z.boolean().optional().describe('Include warnings, not just errors. Default false.'),
  tokenBudget: tokenBudgetArg,
};

type DiagnoseArgs = {
  check?: string;
  command?: string;
  contextLines?: number;
  maxProblems?: number;
  includeWarnings?: boolean;
  tokenBudget?: number;
};

export async function runDiagnose(args: DiagnoseArgs, ctx: ToolContext): Promise<string> {
  const budget = resolveBudget(ctx, args.tokenBudget);
  const checks = await discoverChecks(ctx.workspace);

  if (!args.check && !args.command) return listChecks(checks, ctx, budget);

  const selection = selectCommand(args, checks, ctx);
  if ('error' in selection) return `jb_diagnose — ${selection.error}`;

  const result = await run(selection.argv, ctx.workspace.root, ctx.config.commandTimeoutMs);
  const diagnostics = parseDiagnostics(result.output);

  const includeWarnings = args.includeWarnings ?? false;
  const visible = diagnostics.filter((d) => includeWarnings || d.severity === 'error');
  const maxProblems = args.maxProblems ?? 15;
  const contextLines = args.contextLines ?? 2;

  const writer = new BudgetWriter(budget, FOOTER_RESERVE);
  const status = result.timedOut
    ? `TIMED OUT after ${Math.round(ctx.config.commandTimeoutMs / 1000)}s`
    : result.exitCode === 0
      ? 'passed'
      : `exit ${result.exitCode ?? `signal ${result.signal}`}`;

  writer.pushUnchecked(
    header(
      'jb_diagnose',
      fields(
        selection.argv.join(' '),
        status,
        `${(result.durationMs / 1000).toFixed(1)}s`,
        `${plural(visible.length, 'problem')}${diagnostics.length > visible.length ? ` (+${diagnostics.length - visible.length} warnings)` : ''}`,
      ),
    ),
  );

  if (visible.length === 0) {
    writer.pushUnchecked('');
    writer.pushAll(renderNoProblems(result.exitCode, result.output, includeWarnings, diagnostics.length));
    writer.pushAllUnchecked(footer(writer, budget));
    return writer.toString();
  }

  await renderProblems(visible.slice(0, maxProblems), ctx, writer, contextLines);

  if (visible.length > maxProblems) {
    writer.push('');
    writer.push(`… ${visible.length - maxProblems} further problems; raise maxProblems to see them`);
  }
  if (result.truncated) {
    writer.push(`${GLYPH.warn} command output exceeded the capture limit; later problems may be missing`);
  }

  writer.pushAllUnchecked(footer(writer, budget, 'jb_read {handle:"jb_…"} to open the enclosing symbol of any problem'));
  return writer.toString();
}

// ---------------------------------------------------------------------------

function listChecks(checks: readonly Check[], ctx: ToolContext, budget: number): string {
  const writer = new BudgetWriter(budget, FOOTER_RESERVE);
  writer.pushUnchecked(header('jb_diagnose', `${plural(checks.length, 'check')} available in this project`));
  writer.pushUnchecked('');

  if (checks.length === 0) {
    writer.pushUnchecked('No package.json scripts, Makefile targets, or language defaults were found.');
    if (ctx.config.allowArbitraryCommands || ctx.config.allowedCommands.length > 0) {
      writer.pushUnchecked('This server does permit explicit commands — pass command:"…".');
    } else {
      writer.pushUnchecked('Restart the server with --allow-command "<cmd>" to permit a specific command.');
    }
    return writer.toString();
  }

  for (const check of checks) {
    if (!writer.push(fields(check.name, `→ ${check.argv.join(' ')}`, check.origin))) break;
  }

  writer.pushAllUnchecked(footer(writer, budget, `jb_diagnose {check:"${checks[0]!.name}"}`));
  return writer.toString();
}

function selectCommand(
  args: DiagnoseArgs,
  checks: readonly Check[],
  ctx: ToolContext,
): { argv: string[] } | { error: string } {
  if (args.check) {
    const found = checks.find((c) => c.name === args.check);
    if (found) return { argv: found.argv };
    const names = checks.map((c) => c.name).slice(0, 20).join(', ');
    return { error: `no check named "${args.check}". Available: ${names || 'none'}.` };
  }

  const command = args.command!;
  const argv = splitCommand(command);
  if (argv.length === 0) return { error: 'the command is empty.' };

  if (ctx.config.allowArbitraryCommands) return { argv };

  // An allowlist entry matches if the requested command starts with it, so
  // `--allow-command "npm test"` permits `npm test -- --watch=false` but not
  // `npm publish`.
  const permitted = ctx.config.allowedCommands.some((allowed) => {
    const parts = splitCommand(allowed);
    return parts.length > 0 && parts.every((part, i) => argv[i] === part);
  });
  if (permitted) return { argv };

  return {
    error:
      `running arbitrary commands is disabled. Use check:"…" for a discovered check, or start the server with ` +
      `--allow-command ${JSON.stringify(command)} to permit this one.`,
  };
}

function renderNoProblems(
  exitCode: number | null,
  output: string,
  includeWarnings: boolean,
  totalDiagnostics: number,
): string[] {
  if (exitCode === 0) {
    return ['clean — the check passed and produced no diagnostics.'];
  }

  const lines: string[] = [];
  if (totalDiagnostics > 0 && !includeWarnings) {
    lines.push('no errors, but warnings were reported. Call again with includeWarnings:true to see them.');
    return lines;
  }

  // A non-zero exit with nothing parsed usually means an unrecognised output
  // format. Showing the tail is far more useful than reporting "no problems".
  lines.push('the check failed but no diagnostics were recognised. Last lines of output:');
  lines.push('');
  const tail = toLines(output).filter((l) => l.trim() !== '').slice(-20);
  lines.push(...tail.map((l) => indent(1, truncate(l, 200))));
  return lines;
}

async function renderProblems(
  problems: readonly Diagnostic[],
  ctx: ToolContext,
  writer: BudgetWriter,
  contextLines: number,
): Promise<void> {
  await ctx.index.ensureFresh();

  // Group by file so a path is printed once even when it holds six problems.
  const groups = new Map<string, Diagnostic[]>();
  for (const problem of problems) {
    const key = problem.file ? normalizePath(problem.file, ctx) : '';
    const bucket = groups.get(key);
    if (bucket) bucket.push(problem);
    else groups.set(key, [problem]);
  }

  for (const [path, group] of groups) {
    writer.pushUnchecked('');

    if (path === '') {
      writer.push('(no file location)');
    } else {
      const file = ctx.index.get(path);
      writer.push(fields(path, file ? `${file.lineCount}L` : null, plural(group.length, 'problem')));
    }

    const text = path === '' ? null : await ctx.workspace.readText(path, ctx.config.maxFileBytes);
    const lines = text === null ? null : toLines(text);

    for (const problem of group) {
      const location = problem.line !== undefined ? `:${problem.line}${problem.column ? `:${problem.column}` : ''}` : '';
      const handle =
        path !== '' && problem.line !== undefined ? ctx.handles.mint(handleFor(path, problem.line, ctx)) : null;

      const row = indent(
        1,
        fields(
          `${problem.severity === 'error' ? GLYPH.warn : '~'} ${clampTokens(problem.message, 60)}`,
          problem.code,
          location,
          handle,
        ),
      );
      if (!writer.push(row)) return;
    }

    if (contextLines === 0 || lines === null) continue;

    // Problems cluster: three type errors in one function would otherwise print
    // three nearly identical excerpts. Merge overlapping windows into one block
    // and mark the offending lines instead.
    for (const window of mergeWindows(group, contextLines, lines.length)) {
      const excerpt = numberedLines(lines.slice(window.from - 1, window.to), window.from);
      for (let i = 0; i < excerpt.length; i++) {
        const lineNumber = window.from + i;
        const marker = window.problemLines.has(lineNumber) ? '>' : ' ';
        if (!writer.push(indent(2, marker + truncate(excerpt[i]!, 200)))) return;
      }
    }
  }
}

interface Window {
  from: number;
  to: number;
  /** Lines within the window that a problem points at. */
  problemLines: Set<number>;
}

/** Merge each problem's context window, collapsing overlaps. */
function mergeWindows(problems: readonly Diagnostic[], contextLines: number, lineCount: number): Window[] {
  const located = problems
    .filter((problem): problem is Diagnostic & { line: number } => problem.line !== undefined)
    .sort((a, b) => a.line - b.line);

  const windows: Window[] = [];
  for (const problem of located) {
    const from = Math.max(1, problem.line - contextLines);
    const to = Math.min(lineCount, problem.line + contextLines);
    const last = windows[windows.length - 1];

    if (last && from <= last.to + 1) {
      last.to = Math.max(last.to, to);
      last.problemLines.add(problem.line);
    } else {
      windows.push({ from, to, problemLines: new Set([problem.line]) });
    }
  }
  return windows;
}

/**
 * Map a path from tool output onto a workspace path. Compilers report absolute
 * paths, `./`-prefixed paths, and paths relative to a subdirectory; all three
 * must land on the same indexed file for handles to work.
 */
function normalizePath(reported: string, ctx: ToolContext): string {
  const cleaned = reported.replace(/\\/g, '/').replace(/^\.\//, '');

  if (cleaned.startsWith(ctx.workspace.root.replace(/\\/g, '/'))) {
    const relative = ctx.workspace.relativize(cleaned);
    if (ctx.index.get(relative)) return relative;
  }
  if (ctx.index.get(cleaned)) return cleaned;

  // Fall back to a unique suffix match — `/tmp/build/src/a.ts` → `src/a.ts`.
  const matches = ctx.index.all().filter((file) => cleaned.endsWith('/' + file.path) || file.path.endsWith('/' + cleaned));
  return matches.length === 1 ? matches[0]!.path : cleaned;
}

/** Prefer a handle to the enclosing symbol; fall back to the bare line. */
function handleFor(path: string, line: number, ctx: ToolContext): HandleTarget {
  const file = ctx.index.get(path);
  const symbol = file?.symbols
    .filter((s) => line >= s.startLine && line <= s.endLine)
    .sort((a, b) => b.depth - a.depth)[0];

  return symbol
    ? { path, startLine: symbol.startLine, endLine: symbol.endLine, kind: symbol.kind, label: symbol.name }
    : { path, startLine: line, endLine: line, kind: 'match', label: `${path}:${line}` };
}
