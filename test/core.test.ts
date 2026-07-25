import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_TOKEN_BUDGET, parseArgs } from '../src/config.js';
import { BudgetWriter, clampTokens, estimateTokens } from '../src/core/tokens.js';
import { IgnoreMatcher, compileRule } from '../src/core/ignore.js';
import { HandleStore, handleId, isHandle } from '../src/core/handles.js';
import { splitCommand } from '../src/diagnostics/runner.js';
import { splitIdentifier, tokenizeCode } from '../src/util/text.js';

// --- token accounting -------------------------------------------------------

test('token estimates grow with content and never underflow', () => {
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('hello world') > 0);
  assert.ok(estimateTokens('a'.repeat(400)) > estimateTokens('a'.repeat(40)));
});

test('code is estimated as denser than prose', () => {
  const prose = 'the quick brown fox jumped over the lazy dog again and again ab';
  const code = 'if(a){b=c[d]+e(f,g);}else{h={i:j,k:l};}m(n)?o:p;q=r||s&&t;u+=v;';
  assert.equal(code.length, prose.length, 'the two samples must be the same length to compare density');
  assert.ok(estimateTokens(code) > estimateTokens(prose), 'symbol-heavy text should cost more tokens');
});

test('BudgetWriter never exceeds its budget', () => {
  const writer = new BudgetWriter(60);
  for (let i = 0; i < 500; i++) writer.push(`row ${i} with some trailing text to spend tokens`);

  assert.ok(writer.spent <= 60, `spent ${writer.spent} of 60`);
  assert.ok(writer.omitted > 0, 'nothing was omitted despite a tiny budget');
  assert.ok(writer.isFull);
  assert.ok(estimateTokens(writer.toString()) <= 60);
});

test('BudgetWriter reports remaining budget and accepts what fits', () => {
  const writer = new BudgetWriter(1000);
  assert.equal(writer.push('short row'), true);
  assert.ok(writer.remaining < 1000);
  assert.equal(writer.omitted, 0);
  assert.equal(writer.toString(), 'short row');
});

test('pushUnchecked always writes, even past the budget', () => {
  const writer = new BudgetWriter(1);
  writer.pushUnchecked('a header that must always be present');
  assert.ok(writer.toString().includes('header'));
});

test('pushAll stops at the first row that does not fit', () => {
  const writer = new BudgetWriter(12);
  writer.pushAll(['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff', 'ggg', 'hhh', 'iii', 'jjj']);
  assert.ok(writer.toString().startsWith('aaa'));
  assert.ok(writer.spent <= 12);
});

test('clampTokens shortens to fit and marks the cut', () => {
  const long = 'word '.repeat(200);
  const clamped = clampTokens(long, 20);
  assert.ok(estimateTokens(clamped) <= 20);
  assert.ok(clamped.endsWith('…'));
  assert.equal(clampTokens('short', 100), 'short');
  assert.equal(clampTokens('anything', 0), '');
});

// --- configuration ----------------------------------------------------------

test('--command-timeout is read as seconds, and a bad value falls back to seconds too', () => {
  assert.equal(parseArgs(['--command-timeout', '30'], {}).config.commandTimeoutMs, 30_000);

  // The fallback used to be the default expressed in milliseconds, which was
  // then multiplied by 1000 again — a thirty-three hour timeout.
  const { config } = parseArgs(['--command-timeout', 'nonsense'], {});
  assert.equal(config.commandTimeoutMs, 120_000);
});

test('the advertised budget ceiling matches the one the server enforces', () => {
  assert.equal(parseArgs([], {}).config.maxTokenBudget, MAX_TOKEN_BUDGET);
});

test('the default budget is never allowed above the ceiling', () => {
  const { config } = parseArgs([], { JELLYBEAN_TOKEN_BUDGET: '999999' });
  assert.equal(config.defaultTokenBudget, MAX_TOKEN_BUDGET);
});

test('the first positional argument is the workspace root', () => {
  assert.ok(parseArgs(['/tmp/somewhere'], {}).config.root.endsWith('somewhere'));
});

test('an unknown flag is rejected rather than ignored', () => {
  assert.throws(() => parseArgs(['--not-a-flag'], {}), /Unknown option/);
});

// --- ignore rules -----------------------------------------------------------

test('gitignore basics: names, anchors, and directory-only rules', () => {
  const matcher = new IgnoreMatcher();
  matcher.addGitignore(['node_modules/', '*.log', '/only-root.txt', 'build'].join('\n'));

  assert.equal(matcher.ignores('node_modules', true), true);
  assert.equal(matcher.ignores('deep/node_modules', true), true);
  assert.equal(matcher.ignores('node_modules', false), false, 'a directory-only rule matched a file');
  assert.equal(matcher.ignores('a/b/debug.log', false), true);
  assert.equal(matcher.ignores('only-root.txt', false), true);
  assert.equal(matcher.ignores('nested/only-root.txt', false), false, 'an anchored rule matched at depth');
  assert.equal(matcher.ignores('build', true), true);
  assert.equal(matcher.ignores('src/index.ts', false), false);
});

test('gitignore negation is last-match-wins', () => {
  const matcher = new IgnoreMatcher();
  matcher.addGitignore(['*.log', '!keep.log'].join('\n'));
  assert.equal(matcher.ignores('a.log', false), true);
  assert.equal(matcher.ignores('keep.log', false), false);
});

test('gitignore globstar matches across directories', () => {
  const matcher = new IgnoreMatcher();
  matcher.addGitignore('docs/**/*.tmp');
  assert.equal(matcher.ignores('docs/a.tmp', false), true);
  assert.equal(matcher.ignores('docs/a/b/c.tmp', false), true);
  assert.equal(matcher.ignores('other/a.tmp', false), false);
});

test('a nested gitignore only applies inside its own directory', () => {
  const matcher = new IgnoreMatcher();
  matcher.addGitignore('secret.txt', 'packages/app');
  assert.equal(matcher.ignores('packages/app/secret.txt', false), true);
  assert.equal(matcher.ignores('packages/other/secret.txt', false), false);
});

test('comments and blank lines compile to nothing', () => {
  assert.equal(compileRule('# a comment'), null);
  assert.equal(compileRule('   '), null);
  assert.notEqual(compileRule('\\#literal'), null);
});

test('ignored files inside an ignored directory are also ignored', () => {
  const matcher = new IgnoreMatcher();
  matcher.addGitignore('dist/');
  assert.equal(matcher.ignores('dist/index.js', false), true);
});

// --- handles ----------------------------------------------------------------

test('handles are deterministic and well-formed', () => {
  const target = { path: 'src/a.ts', startLine: 10, endLine: 20, kind: 'function', label: 'run' };
  const first = handleId(target);
  assert.equal(first, handleId({ ...target }));
  assert.ok(isHandle(first), `${first} is not a valid handle`);
  assert.notEqual(first, handleId({ ...target, startLine: 11 }));
});

test('the handle store round-trips a target', () => {
  const store = new HandleStore();
  const id = store.mint({ path: 'src/a.ts', startLine: 1, endLine: 5, kind: 'file', label: 'a' });
  assert.deepEqual(store.get(id)?.path, 'src/a.ts');
  assert.equal(store.get('jb_00000000'), undefined);
});

test('the handle store evicts least-recently-used entries', () => {
  const store = new HandleStore(3);
  const ids = [1, 2, 3].map((n) => store.mint({ path: `f${n}.ts`, startLine: n, endLine: n, kind: 'file', label: 'x' }));

  store.get(ids[0]!); // touch the oldest so it survives
  store.mint({ path: 'f4.ts', startLine: 4, endLine: 4, kind: 'file', label: 'x' });

  assert.equal(store.size, 3);
  assert.ok(store.get(ids[0]!), 'a recently used handle was evicted');
  assert.equal(store.get(ids[1]!), undefined, 'the least recently used handle survived');
});

test('non-handles are rejected', () => {
  for (const value of ['', 'jb_', 'jb_xyz', 'src/a.ts', 'jb_123456789', 'JB_12345678']) {
    assert.equal(isHandle(value), false, `${value} was accepted as a handle`);
  }
});

// --- command splitting ------------------------------------------------------

test('command splitting handles quoting without interpreting shell syntax', () => {
  assert.deepEqual(splitCommand('npm run test'), ['npm', 'run', 'test']);
  assert.deepEqual(splitCommand('cmd "two words" plain'), ['cmd', 'two words', 'plain']);
  assert.deepEqual(splitCommand("cmd 'single quoted'"), ['cmd', 'single quoted']);
  assert.deepEqual(splitCommand('  spaced   out  '), ['spaced', 'out']);
  assert.deepEqual(splitCommand(''), []);
  assert.deepEqual(splitCommand('cmd ""'), ['cmd', ''], 'an explicit empty argument was dropped');
});

test('shell operators become literal arguments, not new commands', () => {
  // The point of splitCommand: `;` and `&&` cannot chain, and `$(…)` cannot expand.
  assert.deepEqual(splitCommand('echo hi; rm -rf /'), ['echo', 'hi;', 'rm', '-rf', '/']);
  assert.deepEqual(splitCommand('echo $(whoami)'), ['echo', '$(whoami)']);
  assert.deepEqual(splitCommand('a && b'), ['a', '&&', 'b']);
});

// --- identifier tokenizing --------------------------------------------------

test('identifiers split on case and separators', () => {
  assert.deepEqual(splitIdentifier('parseHTTPResponse'), ['parse', 'http', 'response']);
  assert.deepEqual(splitIdentifier('user_id_map'), ['user', 'id', 'map']);
  assert.deepEqual(splitIdentifier('getURL'), ['get', 'url']);
  assert.deepEqual(splitIdentifier('simple'), ['simple']);
});

test('the fast sub-word split agrees with the readable one', () => {
  // countCodeTerms hand-rolls character scanning for speed. It must produce
  // exactly what splitIdentifier produces, or search silently changes meaning.
  const identifiers = [
    'parseHTTPResponse', 'user_id_map', 'getURL', 'simple', 'XMLHttpRequest', 'a', 'AB', 'aB',
    'snake_case_name', '_leading', 'trailing_', '__dunder__', 'mixed_Case_Name', 'v2Migration',
    'HTTP2Server', 'toJSON', 'IOError', 'x1y2z3', '$dollar', 'a$b', 'ALLCAPS', 'camelCase',
  ];

  for (const identifier of identifiers) {
    const expected = new Set(splitIdentifier(identifier));
    expected.add(identifier.toLowerCase());

    const actual = new Set(tokenizeCode(identifier));
    assert.deepEqual(
      [...actual].sort(),
      [...expected].sort(),
      `disagreement on ${identifier}`,
    );
  }
});

test('numeric literals are not indexed as terms', () => {
  assert.deepEqual(tokenizeCode('const x = 12345;').includes('12345'), false);
  assert.ok(tokenizeCode('const x = 12345;').includes('const'));
});

test('code tokenizing emits whole identifiers and their parts', () => {
  const tokens = tokenizeCode('const getUserName = 1;');
  assert.ok(tokens.includes('getusername'));
  assert.ok(tokens.includes('user'));
  assert.ok(tokens.includes('name'));
});
