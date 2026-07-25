/**
 * `jb_notes` — durable findings, anchored to files.
 *
 * Everything else in Jelly Bean makes reading a repository cheaper. This makes
 * it unnecessary: a conclusion that cost twenty tool calls to reach ("the retry
 * budget is deliberately shared across shards — see the comment in
 * transport.ts") is written once and recalled for a handful of tokens.
 *
 * Notes live in a plain JSON file inside the workspace, so a human can read,
 * edit, review, or commit them. That is deliberate — an agent's accumulated
 * understanding of a codebase should not be locked in a private store.
 */

import { z } from 'zod';
import { BudgetWriter } from '../core/tokens.js';
import { fields, FOOTER_RESERVE, footer, header, indent, plural } from '../core/render.js';
import { truncate } from '../util/text.js';
import { resolveBudget, tokenBudgetArg, type ToolContext } from './context.js';

export const notesSchema = {
  action: z
    .enum(['add', 'list', 'search', 'remove'])
    .describe('"add" records a finding, "search" recalls relevant ones, "list" shows all, "remove" deletes by id.'),
  text: z.string().optional().describe('The finding, for action "add". Write the conclusion, not the investigation.'),
  paths: z
    .array(z.string())
    .optional()
    .describe('Files the note concerns. These make it surface automatically in jb_trace on those files.'),
  tags: z.array(z.string()).optional().describe('Short labels for grouping, e.g. ["auth", "gotcha"].'),
  query: z.string().optional().describe('What to recall, for action "search".'),
  id: z.string().optional().describe('Note id, for action "remove".'),
  limit: z.number().int().min(1).max(100).optional().describe('How many notes to return. Default 20.'),
  tokenBudget: tokenBudgetArg,
};

type NotesArgs = {
  action: 'add' | 'list' | 'search' | 'remove';
  text?: string;
  paths?: string[];
  tags?: string[];
  query?: string;
  id?: string;
  limit?: number;
  tokenBudget?: number;
};

export async function runNotes(args: NotesArgs, ctx: ToolContext): Promise<string> {
  const budget = resolveBudget(ctx, args.tokenBudget);
  const limit = args.limit ?? 20;

  switch (args.action) {
    case 'add': {
      if (!args.text || args.text.trim() === '') {
        return 'jb_notes — action "add" needs text.';
      }
      // Validate paths against the workspace so a note cannot silently anchor
      // to a file that does not exist and then never surface again.
      const paths: string[] = [];
      const unknown: string[] = [];
      for (const path of args.paths ?? []) {
        const cleaned = path.replace(/^\.?\/+/, '');
        if ((await ctx.workspace.kindOf(cleaned)) === 'missing') unknown.push(cleaned);
        else paths.push(cleaned);
      }

      const note = await ctx.notes.add(args.text, paths, args.tags ?? []);
      return fields(
        `jb_notes — saved ${note.id}`,
        paths.length > 0 ? `anchored to ${paths.join(' ')}` : null,
        unknown.length > 0 ? `(ignored missing: ${unknown.join(' ')})` : null,
      );
    }

    case 'remove': {
      if (!args.id) return 'jb_notes — action "remove" needs an id.';
      const removed = await ctx.notes.remove(args.id);
      return removed ? `jb_notes — removed ${args.id}` : `jb_notes — no note with id ${args.id}`;
    }

    case 'search':
    case 'list': {
      const notes =
        args.action === 'search' ? await ctx.notes.search(args.query ?? '', limit) : (await ctx.notes.list()).slice(0, limit);

      const writer = new BudgetWriter(budget, FOOTER_RESERVE);
      writer.pushUnchecked(
        header('jb_notes', fields(args.action, args.query ? `"${truncate(args.query, 40)}"` : null, plural(notes.length, 'note'))),
      );
      writer.pushUnchecked('');

      if (notes.length === 0) {
        writer.pushUnchecked(
          args.action === 'search'
            ? 'nothing recorded matches. Notes are only as good as what has been written down.'
            : 'no notes yet. Record findings with jb_notes {action:"add", text:"…", paths:["…"]}.',
        );
        return writer.toString();
      }

      for (const note of notes) {
        const meta = fields(note.id, note.createdAt.slice(0, 10), note.tags.length > 0 ? note.tags.join(',') : null);
        if (!writer.push(meta)) break;
        if (!writer.push(indent(1, note.text))) break;
        if (note.paths.length > 0 && !writer.push(indent(1, `↳ ${note.paths.join(' ')}`))) break;
      }

      writer.pushAllUnchecked(footer(writer, budget));
      return writer.toString();
    }

    default:
      return `jb_notes — unknown action.`;
  }
}
