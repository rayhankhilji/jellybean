import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskSource, SYNTAX_JS, SYNTAX_PYTHON, SYNTAX_RUST } from '../src/lang/scanner.js';

/** The mask must never change a file's length or line structure. */
function assertAligned(source: string, masked: string): void {
  assert.equal(masked.length, source.length, 'mask changed the length');
  assert.equal(masked.split('\n').length, source.split('\n').length, 'mask changed the line count');
  const sourceLines = source.split('\n');
  masked.split('\n').forEach((line, i) => {
    assert.equal(line.length, sourceLines[i]!.length, `line ${i + 1} changed length`);
  });
}

test('blanks string contents but keeps offsets', () => {
  const source = 'const a = "hello}world";\nconst b = 1;\n';
  const masked = maskSource(source, SYNTAX_JS);
  assertAligned(source, masked);
  assert.ok(!masked.includes('hello'), 'string body survived');
  assert.ok(!masked.includes('}'), 'brace inside a string survived');
  assert.ok(masked.includes('const b = 1;'), 'real code was blanked');
});

test('a brace inside a string does not affect depth', () => {
  const source = 'function f() {\n  const s = "}";\n  return s;\n}\n';
  const masked = maskSource(source, SYNTAX_JS);
  const opens = (masked.match(/\{/g) ?? []).length;
  const closes = (masked.match(/\}/g) ?? []).length;
  assert.equal(opens, 1);
  assert.equal(closes, 1);
});

test('blanks line and block comments', () => {
  const source = '// function fake() {}\nconst a = 1; /* class Nope { */\n';
  const masked = maskSource(source, SYNTAX_JS);
  assertAligned(source, masked);
  assert.ok(!masked.includes('fake'));
  assert.ok(!masked.includes('Nope'));
  assert.ok(masked.includes('const a = 1;'));
});

test('template literals keep interpolated code visible', () => {
  const source = 'const t = `text ${value + 1} more`;\n';
  const masked = maskSource(source, SYNTAX_JS);
  assertAligned(source, masked);
  assert.ok(!masked.includes('text'), 'literal part survived');
  assert.ok(!masked.includes('more'), 'trailing literal part survived');
  assert.ok(masked.includes('value + 1'), 'interpolation was wrongly blanked');
});

test('nested template interpolation balances braces', () => {
  const source = 'const t = `a ${ f({ k: `inner ${x}` }) } b`;\nconst after = 2;\n';
  const masked = maskSource(source, SYNTAX_JS);
  assertAligned(source, masked);
  const opens = (masked.match(/\{/g) ?? []).length;
  const closes = (masked.match(/\}/g) ?? []).length;
  assert.equal(opens, closes, 'unbalanced braces after template masking');
  assert.ok(masked.includes('const after = 2;'), 'masking ran past the template');
});

test('regex literals are masked, division is not', () => {
  const source = 'const re = /["{}]/g;\nconst half = total / 2;\n';
  const masked = maskSource(source, SYNTAX_JS);
  assertAligned(source, masked);
  assert.ok(!masked.includes('{'), 'brace inside a regex survived');
  assert.ok(masked.includes('total / 2'), 'division was treated as a regex');
});

test('an unterminated string stops at the newline', () => {
  const source = 'const bad = "oops\nfunction after() {}\n';
  const masked = maskSource(source, SYNTAX_JS);
  assertAligned(source, masked);
  assert.ok(masked.includes('function after()'), 'one bad quote swallowed the file');
});

test('python triple-quoted strings are blanked whole', () => {
  const source = 'def f():\n    """doc with def fake(): and } brace"""\n    return 1\n';
  const masked = maskSource(source, SYNTAX_PYTHON);
  assertAligned(source, masked);
  assert.ok(!masked.includes('fake'));
  assert.ok(masked.includes('return 1'));
});

test('rust nested block comments close correctly', () => {
  const source = '/* outer /* inner */ still comment */\nfn real() {}\n';
  const masked = maskSource(source, SYNTAX_RUST);
  assertAligned(source, masked);
  assert.ok(!masked.includes('still'));
  assert.ok(masked.includes('fn real()'));
});

test('handles an empty file', () => {
  assert.equal(maskSource('', SYNTAX_JS), '');
});
