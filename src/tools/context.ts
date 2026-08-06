/** Shared plumbing for tool handlers. */

import { z } from 'zod';
import { MAX_TOKEN_BUDGET, type JellyBeanConfig } from '../config.js';
import type { CodeIndex } from '../core/code-index.js';
import type { HandleStore } from '../core/handles.js';
import type { NotesStore } from '../core/notes.js';
import type { Workspace } from '../core/workspace.js';

export interface ToolContext {
  config: JellyBeanConfig;
  workspace: Workspace;
  index: CodeIndex;
  handles: HandleStore;
  notes: NotesStore;
}

/** The token budget argument, shared verbatim by every tool that produces rows. */
export const tokenBudgetArg = z
  .number()
  .int()
  .min(100)
  .max(MAX_TOKEN_BUDGET)
  .optional()
  .describe(
    `Maximum tokens the result may occupy (default 2000, ceiling ${MAX_TOKEN_BUDGET}). The tool degrades detail to fit rather than truncating mid-row.`,
  );

/** Clamp a requested budget to what this server is configured to allow. */
export function resolveBudget(ctx: ToolContext, requested: number | undefined): number {
  if (requested === undefined) return ctx.config.defaultTokenBudget;
  return Math.min(Math.max(requested, 100), ctx.config.maxTokenBudget);
}

/** MCP tool results are a content array; every Jelly Bean tool returns one text block. */
export function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

/**
 * Wrap a handler so a thrown error becomes a readable message instead of a
 * transport-level failure. An agent can act on "no such file"; it cannot act on
 * a dropped connection.
 */
export function guard<Args>(
  handler: (args: Args, ctx: ToolContext) => Promise<string>,
  ctx: ToolContext,
): (args: Args) => Promise<ReturnType<typeof textResult> & { isError?: boolean }> {
  return async (args: Args) => {
    try {
      return textResult(await answer(handler, args, ctx));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...textResult(`error: ${message}`), isError: true };
    }
  };
}

/**
 * How long a call will wait on the very first scan before saying so instead.
 *
 * Comfortably inside the request timeout of every client we know of, and long
 * enough that no ordinary repository ever sees this path — nest finishes its
 * first scan in about two seconds.
 */
const FIRST_SCAN_GRACE_MS = 20_000;

/**
 * Run a handler, but do not let the first scan of a large repository look like
 * a hang.
 *
 * The server connects before indexing finishes, so a call can arrive while the
 * tree is still being walked. Blocking until it completes means the client's
 * request timeout fires, and what the agent gets is a transport error with no
 * explanation — from which the reasonable conclusion is that the server is
 * broken. "Still indexing, N of M files, retry shortly" is a fact it can act on.
 */
async function answer<Args>(
  handler: (args: Args, ctx: ToolContext) => Promise<string>,
  args: Args,
  ctx: ToolContext,
): Promise<string> {
  const work = handler(args, ctx);
  if (ctx.index.ready) return work;

  let timer: NodeJS.Timeout | undefined;
  const patience = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), FIRST_SCAN_GRACE_MS);
    timer.unref?.();
  });

  try {
    const finished = await Promise.race([work.then((text) => ({ text })), patience]);
    if (finished) return finished.text;
  } finally {
    clearTimeout(timer);
  }

  // The call is abandoned, not cancelled — it will finish and its result will be
  // discarded. If it fails instead, that must not surface as an unhandled
  // rejection and take the process down.
  void work.catch(() => undefined);
  return stillIndexing(ctx);
}

function stillIndexing(ctx: ToolContext): string {
  const { done, total } = ctx.index.progress();
  const scale = total === null ? `${done} files so far` : `${done} of ${total} files`;

  return [
    `jb — still indexing ${ctx.config.root}`,
    '',
    `Indexed ${scale}. The first scan of a large repository takes tens of seconds;`,
    'after it, calls are answered from memory in milliseconds and stay up to date as',
    'you edit. This happens once.',
    '',
    'Retry shortly. Nothing needs restarting, and no call has failed.',
  ].join('\n');
}
