import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDiagnostics, type Diagnostic } from '../src/diagnostics/parsers.js';

function one(output: string): Diagnostic {
  const found = parseDiagnostics(output);
  assert.ok(found.length >= 1, `nothing parsed from:\n${output}`);
  return found[0]!;
}

test('typescript: parenthesised locations', () => {
  const d = one("src/a.ts(12,5): error TS2345: Argument of type 'string' is not assignable.");
  assert.equal(d.file, 'src/a.ts');
  assert.equal(d.line, 12);
  assert.equal(d.column, 5);
  assert.equal(d.code, 'TS2345');
  assert.equal(d.severity, 'error');
  assert.ok(d.message.startsWith('Argument of type'));
});

test('typescript: colon-and-dash locations', () => {
  const d = one('src/b.ts:8:1 - error TS1005: ";" expected.');
  assert.equal(d.file, 'src/b.ts');
  assert.equal(d.line, 8);
  assert.equal(d.code, 'TS1005');
});

test('eslint: the file header applies to the rows beneath it', () => {
  const found = parseDiagnostics(
    ['/repo/src/app.js', '  12:5   error    Unexpected console statement  no-console', '  20:1   warning  Missing semicolon  semi', ''].join('\n'),
  );
  const errors = found.filter((d) => d.source === 'eslint');
  assert.equal(errors.length, 2);
  assert.equal(errors[0]!.file, '/repo/src/app.js');
  assert.equal(errors[0]!.line, 12);
  assert.equal(errors[0]!.code, 'no-console');
  assert.equal(errors.find((d) => d.line === 20)!.severity, 'warning');
});

test('cargo: the location follows the message', () => {
  const found = parseDiagnostics(
    ['error[E0308]: mismatched types', '  --> src/main.rs:10:20', '   |', '10 |     let x: u8 = "s";', ''].join('\n'),
  );
  const d = found.find((x) => x.code === 'E0308');
  assert.ok(d, 'the cargo diagnostic was not found');
  assert.equal(d.file, 'src/main.rs');
  assert.equal(d.line, 10);
  assert.equal(d.column, 20);
});

test('python: the deepest project frame wins over library frames', () => {
  const found = parseDiagnostics(
    [
      'Traceback (most recent call last):',
      '  File "/repo/app/main.py", line 5, in handler',
      '    do_work()',
      '  File "/usr/lib/python3.12/site-packages/lib/x.py", line 99, in inner',
      '    raise ValueError("bad input")',
      'ValueError: bad input',
    ].join('\n'),
  );

  const d = found.find((x) => x.code === 'ValueError');
  assert.ok(d, 'the traceback was not parsed');
  assert.equal(d.file, '/repo/app/main.py', 'a site-packages frame was preferred over project code');
  assert.equal(d.line, 5);
  assert.ok(d.message.includes('bad input'));
  assert.ok(d.message.includes('handler'), 'the failing function was not reported');
});

test('pytest: FAILED lines become located problems', () => {
  const found = parseDiagnostics('FAILED tests/test_api.py::test_create - AssertionError: 404 != 201');
  const d = found.find((x) => x.source === 'pytest');
  assert.ok(d);
  assert.equal(d.file, 'tests/test_api.py');
  assert.equal(d.code, 'test_create');
  assert.ok(d.message.includes('404'));
});

test('jest: a failure title is paired with the first project frame', () => {
  const found = parseDiagnostics(
    [
      '  ● Calculator › adds numbers',
      '',
      '    expected 4 but received 5',
      '',
      '      at Object.<anonymous> (/repo/node_modules/expect/index.js:1:1)',
      '      at Object.<anonymous> (src/calc.test.ts:14:22)',
    ].join('\n'),
  );

  const d = found.find((x) => x.source === 'jest');
  assert.ok(d, 'the jest failure was not parsed');
  assert.equal(d.file, 'src/calc.test.ts', 'a node_modules frame was chosen');
  assert.equal(d.line, 14);
  assert.ok(d.message.includes('Calculator'));
});

test('go: compile errors and test failures', () => {
  const found = parseDiagnostics(['./pkg/svc/handler.go:22:9: undefined: doThing', '--- FAIL: TestHandler (0.00s)'].join('\n'));

  const compile = found.find((x) => x.file === 'pkg/svc/handler.go');
  assert.ok(compile, 'the go compile error was not parsed');
  assert.equal(compile.line, 22);
  assert.ok(found.some((x) => x.code === 'TestHandler'));
});

test('maven: bracketed locations', () => {
  const d = one('[ERROR] /repo/src/Main.java:[14,20] cannot find symbol');
  assert.equal(d.file, '/repo/src/Main.java');
  assert.equal(d.line, 14);
  assert.equal(d.column, 20);
});

test('generic: gcc-style output with an explicit severity', () => {
  const d = one('src/util.c:44:7: warning: unused variable "tmp"');
  assert.equal(d.file, 'src/util.c');
  assert.equal(d.line, 44);
  assert.equal(d.severity, 'warning');
});

test('log lines with colons and numbers are not mistaken for diagnostics', () => {
  const found = parseDiagnostics(
    ['Listening on http://localhost:3000', 'ran 42 tests in 1:23', 'INFO  cache:hit 12 entries'].join('\n'),
  );
  assert.deepEqual(found, [], `phantom diagnostics: ${JSON.stringify(found)}`);
});

test('duplicates across parsers collapse to one, keeping the richer version', () => {
  const found = parseDiagnostics(
    ['src/a.ts(3,1): error TS2304: Cannot find name "foo".', 'src/a.ts:3:1: error: Cannot find name "foo".'].join('\n'),
  );
  const aboutA = found.filter((d) => d.file?.includes('src/a.ts'));
  assert.equal(aboutA.length, 1, `expected one merged diagnostic, got ${aboutA.length}`);
  assert.equal(aboutA[0]!.code, 'TS2304', 'the specific parser lost to the generic one');
});

test('errors are ranked before warnings', () => {
  const found = parseDiagnostics(
    ['src/a.ts(1,1): warning TS6133: unused', 'src/b.ts(2,2): error TS2345: broken'].join('\n'),
  );
  assert.equal(found[0]!.severity, 'error');
});

test('empty and unrecognised output parse to nothing without throwing', () => {
  assert.deepEqual(parseDiagnostics(''), []);
  assert.deepEqual(parseDiagnostics('all good\ndone in 2s\n'), []);
});

test('a bare Error line is still reported', () => {
  const found = parseDiagnostics('Error: connect ECONNREFUSED 127.0.0.1:5432');
  assert.equal(found.length, 1);
  assert.ok(found[0]!.message.includes('ECONNREFUSED'));
  assert.equal(found[0]!.file, undefined);
});
