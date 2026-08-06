/**
 * Cross-session findings.
 *
 * An agent that re-derives "the retry logic lives in transport.ts and the
 * backoff is deliberately non-jittered" on every session is paying for the same
 * investigation repeatedly. Notes let it write the conclusion down, anchored to
 * the files it concerns, and get it back cheaply next time.
 *
 * Stored as a single JSON file inside the workspace so notes travel with the
 * repository and can be inspected, edited, or committed by a human.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { splitIdentifier } from '../util/text.js';

export interface Note {
  id: string;
  /** The finding itself. */
  text: string;
  /** Workspace paths the note is about; used to surface it during other calls. */
  paths: string[];
  tags: string[];
  createdAt: string;
}

interface NotesFile {
  version: 1;
  notes: Note[];
}

/** Beyond this the file stops being a cache and starts being a liability. */
const MAX_NOTES = 500;

export class NotesStore {
  private notes: Note[] | null = null;

  constructor(private readonly absolutePath: string) {}

  static forWorkspace(root: string, relativePath: string): NotesStore {
    return new NotesStore(resolve(root, relativePath));
  }

  /** Where notes are stored, for diagnostics. */
  get path(): string {
    return this.absolutePath;
  }

  private async load(): Promise<Note[]> {
    if (this.notes) return this.notes;
    try {
      const raw = await readFile(this.absolutePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<NotesFile>;
      this.notes = Array.isArray(parsed.notes) ? parsed.notes.filter(isNote) : [];
    } catch {
      // Missing or corrupt: start clean rather than failing every notes call.
      this.notes = [];
    }
    return this.notes;
  }

  /**
   * Persist atomically. A half-written notes file would be silently discarded
   * by `load()` above, quietly losing every finding the agent had recorded.
   */
  private async save(): Promise<void> {
    const payload: NotesFile = { version: 1, notes: this.notes ?? [] };
    await mkdir(dirname(this.absolutePath), { recursive: true });
    const temporary = `${this.absolutePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    await rename(temporary, this.absolutePath);
  }

  async add(text: string, paths: string[], tags: string[]): Promise<Note> {
    const notes = await this.load();
    const note: Note = {
      id: randomUUID().slice(0, 8),
      text: text.trim(),
      paths,
      tags,
      createdAt: new Date().toISOString(),
    };
    notes.unshift(note);
    if (notes.length > MAX_NOTES) notes.length = MAX_NOTES;
    await this.save();
    return note;
  }

  async remove(id: string): Promise<boolean> {
    const notes = await this.load();
    const at = notes.findIndex((n) => n.id === id);
    if (at === -1) return false;
    notes.splice(at, 1);
    await this.save();
    return true;
  }

  async list(): Promise<Note[]> {
    return [...(await this.load())];
  }

  /**
   * Rank notes against a query. Scoring is intentionally simple — a notes file
   * holds hundreds of entries, not millions, so recall matters more than
   * precision and an exact-substring boost is enough to keep the best on top.
   */
  async search(query: string, limit: number): Promise<Note[]> {
    const notes = await this.load();
    if (query.trim() === '') return notes.slice(0, limit);

    const terms = new Set(splitIdentifier(query));
    const needle = query.toLowerCase();

    const scored = notes.map((note) => {
      const haystack = `${note.text} ${note.paths.join(' ')} ${note.tags.join(' ')}`.toLowerCase();
      let score = haystack.includes(needle) ? 5 : 0;
      for (const term of terms) if (haystack.includes(term)) score += 1;
      return { note, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.note);
  }

  /** Notes attached to any of the given paths. Used to enrich other tools' output. */
  async forPaths(paths: readonly string[], limit: number): Promise<Note[]> {
    const wanted = new Set(paths);
    const notes = await this.load();
    return notes.filter((note) => note.paths.some((p) => wanted.has(p))).slice(0, limit);
  }
}

function isNote(value: unknown): value is Note {
  if (typeof value !== 'object' || value === null) return false;
  const note = value as Partial<Note>;
  return (
    typeof note.id === 'string' &&
    typeof note.text === 'string' &&
    Array.isArray(note.paths) &&
    Array.isArray(note.tags)
  );
}
