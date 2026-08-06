/**
 * Tool-wrapper tests.
 *
 * `guard` is the only thing standing between a handler and the wire, so both of
 * its jobs are failure-shaped: turn a thrown error into something an agent can
 * read, and stop the first scan of a large repository from looking like a hang.
 *
 * The second only triggers on a repository too big to build in a test, so the
 * clock is faked rather than the repository.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guard, type ToolContext } from '../src/tools/context.js';

/** A context with just enough on it for `guard`; the tools themselves are not run. */
function contextWith(index: { ready: boolean; done?: number; total?: number | null }): ToolContext {
  return {
    config: { root: '/repo/api' },
    index: {
      ready: index.ready,
      progress: () => ({ done: index.done ?? 0, total: index.total ?? null }),
    },
  } as unknown as ToolContext;
}

function textOf(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? '';
}

test('a handler that resolves is returned as text', async () => {
  const guarded = guard(async () => 'the answer', contextWith({ ready: true }));
  const result = await guarded({});
  assert.equal(textOf(result), 'the answer');
  assert.equal(result.isError, undefined);
});

test('a thrown error becomes a readable result, not a transport failure', async () => {
  const guarded = guard(async () => {
    throw new Error('no such file: src/ghost.ts');
  }, contextWith({ ready: true }));

  const result = await guarded({});
  assert.equal(result.isError, true);
  assert.match(textOf(result), /no such file: src\/ghost\.ts/);
});

test('a slow call is not interrupted once the first scan has finished', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  // Being past the first scan means there is nothing to explain, so a long call
  // is simply a long call — the deadline must not apply to it at all.
  const guarded = guard(async () => 'eventually', contextWith({ ready: true }));
  const result = await guarded({});
  assert.equal(textOf(result), 'eventually');
});

test('a call during the first scan reports progress instead of hanging', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const guarded = guard(
    () => new Promise<string>(() => undefined), // never settles, like a scan in progress
    contextWith({ ready: false, done: 4200, total: 16494 }),
  );

  const pending = guarded({});
  await Promise.resolve(); // let the race be set up before the clock moves
  t.mock.timers.tick(20_000);

  const result = await pending;
  const text = textOf(result);
  assert.match(text, /still indexing \/repo\/api/);
  assert.match(text, /4200 of 16494 files/);
  assert.match(text, /Retry shortly/);
  // Not an error: nothing failed, and an agent that treats it as one will give
  // up rather than call again a moment later.
  assert.equal(result.isError, undefined);
});

test('progress reads honestly before the walk knows the total', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const guarded = guard(
    () => new Promise<string>(() => undefined),
    contextWith({ ready: false, done: 300, total: null }),
  );

  const pending = guarded({});
  await Promise.resolve();
  t.mock.timers.tick(20_000);

  assert.match(textOf(await pending), /300 files so far/);
});

test('a call that finishes inside the grace period returns its own answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const guarded = guard(async () => 'partial but real', contextWith({ ready: false, done: 10, total: 20 }));
  const result = await guarded({});

  // Indexing is incomplete, but the tool answered — that answer is what the
  // caller asked for, not a status report about the scan.
  assert.equal(textOf(result), 'partial but real');
});

test('a call abandoned at the deadline cannot crash the process later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  let fail: (error: Error) => void = () => undefined;
  const guarded = guard(
    () => new Promise<string>((_resolve, reject) => (fail = reject)),
    contextWith({ ready: false, done: 1, total: 100 }),
  );

  const pending = guarded({});
  await Promise.resolve();
  t.mock.timers.tick(20_000);
  assert.match(textOf(await pending), /still indexing/);

  // The handler is still running with nobody waiting on it. Rejecting now must
  // be swallowed; an unhandled rejection here would take the server down long
  // after the call it belonged to was answered.
  fail(new Error('the abandoned call failed'));
  await new Promise((resolve) => setImmediate(resolve));
});
