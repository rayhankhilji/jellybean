import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractSymbols } from '../src/lang/outline.js';
import type { CodeSymbol } from '../src/lang/types.js';

function find(symbols: readonly CodeSymbol[], name: string): CodeSymbol {
  const found = symbols.find((s) => s.name === name);
  assert.ok(found, `no symbol named ${name} (found: ${symbols.map((s) => s.name).join(', ')})`);
  return found;
}

test('typescript: classes, methods, and extents', () => {
  const source = [
    'export class Service {',
    '  private cache = new Map();',
    '',
    '  async fetch(id: string): Promise<string> {',
    '    return id;',
    '  }',
    '}',
    '',
    'function helper() {',
    '  const inner = () => 1;',
    '  return inner;',
    '}',
  ].join('\n');

  const symbols = extractSymbols(source, 'typescript');

  const service = find(symbols, 'Service');
  assert.equal(service.kind, 'class');
  assert.equal(service.startLine, 1);
  assert.equal(service.endLine, 7);
  assert.equal(service.exported, true);

  const fetch = find(symbols, 'fetch');
  assert.equal(fetch.kind, 'method');
  assert.equal(fetch.depth, 1);
  assert.equal(fetch.startLine, 4);
  assert.equal(fetch.endLine, 6);

  const helper = find(symbols, 'helper');
  assert.equal(helper.exported, false);
  assert.equal(helper.endLine, 12);

  // The closure inside `helper` is a local detail and must not appear.
  assert.equal(
    symbols.some((s) => s.name === 'inner'),
    false,
    'a nested closure leaked into the outline',
  );
});

test('typescript: arrow functions are functions, other bindings are not', () => {
  const source = [
    'export const handler = async (req: Request) => {',
    '  return req;',
    '};',
    'export const LIMIT = 42;',
    'const mapper = (x: number) => x * 2;',
  ].join('\n');

  const symbols = extractSymbols(source, 'typescript');
  assert.equal(find(symbols, 'handler').kind, 'function');
  assert.equal(find(symbols, 'mapper').kind, 'function');
  assert.equal(find(symbols, 'LIMIT').kind, 'constant');
});

test('typescript: a multi-line array initializer gets its full extent', () => {
  const source = ['const ITEMS = [', "  'a',", "  'b',", '];', 'const after = 1;'].join('\n');

  const items = find(extractSymbols(source, 'typescript'), 'ITEMS');
  assert.equal(items.startLine, 1);
  assert.equal(items.endLine, 4);
});

test('typescript: a wrapped signature is captured whole and stops before the body', () => {
  const source = [
    'export function combine(',
    '  first: string,',
    '  second: string,',
    '): string {',
    '  return first + second;',
    '}',
  ].join('\n');

  const combine = find(extractSymbols(source, 'typescript'), 'combine');
  assert.equal(combine.endLine, 6);
  assert.ok(combine.signature.includes('second: string'), `signature lost its parameters: ${combine.signature}`);
  assert.ok(!combine.signature.includes('{'), `signature includes the body brace: ${combine.signature}`);
});

test('typescript: declarations inside comments and strings are ignored', () => {
  const source = ['// export class Ghost {}', 'const sql = "create function phantom()";', 'export class Real {}'].join(
    '\n',
  );

  const names = extractSymbols(source, 'typescript').map((s) => s.name);
  assert.deepEqual(names.includes('Ghost'), false);
  assert.deepEqual(names.includes('phantom'), false);
  assert.ok(names.includes('Real'));
});

test('typescript: doc comments are attached', () => {
  const source = ['/**', ' * Adds two numbers.', ' */', 'export function add(a: number, b: number) {', '  return a + b;', '}'].join('\n');
  assert.equal(find(extractSymbols(source, 'typescript'), 'add').doc, 'Adds two numbers.');
});

test('python: indentation determines extents and method kinds', () => {
  const source = [
    'class Repo:',
    '    """A repository."""',
    '',
    '    def find(self, key):',
    '        return key',
    '',
    '    def _hidden(self):',
    '        pass',
    '',
    'def top_level():',
    '    return 1',
  ].join('\n');

  const symbols = extractSymbols(source, 'python');

  const repo = find(symbols, 'Repo');
  assert.equal(repo.kind, 'class');
  assert.equal(repo.startLine, 1);
  assert.equal(repo.endLine, 8);

  const findMethod = find(symbols, 'find');
  assert.equal(findMethod.kind, 'method');
  assert.equal(findMethod.depth, 1);
  assert.equal(findMethod.endLine, 5);

  assert.equal(find(symbols, '_hidden').exported, false);
  assert.equal(find(symbols, 'top_level').depth, 0);
});

test('go: receivers become methods and case decides visibility', () => {
  const source = [
    'package main',
    '',
    'type Server struct {',
    '\tport int',
    '}',
    '',
    'func (s *Server) Start() error {',
    '\treturn nil',
    '}',
    '',
    'func helper() {}',
  ].join('\n');

  const symbols = extractSymbols(source, 'go');
  assert.equal(find(symbols, 'Server').kind, 'struct');
  assert.equal(find(symbols, 'Start').kind, 'method');
  assert.equal(find(symbols, 'Start').exported, true);
  assert.equal(find(symbols, 'helper').exported, false);
});

test('rust: pub decides visibility and impl blocks contain methods', () => {
  const source = [
    'pub struct Config {',
    '    pub name: String,',
    '}',
    '',
    'impl Config {',
    '    pub fn new() -> Self {',
    '        Self { name: String::new() }',
    '    }',
    '',
    '    fn internal(&self) {}',
    '}',
  ].join('\n');

  const symbols = extractSymbols(source, 'rust');
  assert.equal(find(symbols, 'Config').exported, true);
  assert.equal(find(symbols, 'new').exported, true);
  assert.equal(find(symbols, 'internal').exported, false);
  assert.equal(find(symbols, 'new').depth, 1);
  assert.ok(
    symbols.some((s) => s.name === 'impl Config'),
    'the impl block should be listed distinctly from the struct',
  );
});

test('python: dunder methods are public, single-underscore names are not', () => {
  const source = ['class Thing:', '    def __init__(self):', '        pass', '', '    def _helper(self):', '        pass'].join(
    '\n',
  );
  const symbols = extractSymbols(source, 'python');
  assert.equal(find(symbols, '__init__').exported, true, '__init__ is part of a class\'s public protocol');
  assert.equal(find(symbols, '_helper').exported, false);
});

test('rust: trait items and trait impls are public, inherent impls need pub', () => {
  const source = [
    'pub trait Loader {',
    '    fn load(&self) -> Option<String>;',
    '}',
    '',
    'pub struct Config;',
    '',
    'impl Config {',
    '    fn inherent_private(&self) {}',
    '}',
    '',
    'impl Loader for Config {',
    '    fn load(&self) -> Option<String> {',
    '        None',
    '    }',
    '}',
  ].join('\n');

  const symbols = extractSymbols(source, 'rust');
  const loads = symbols.filter((s) => s.name === 'load');
  assert.equal(loads.length, 2, 'expected the trait declaration and its implementation');
  assert.ok(
    loads.every((s) => s.exported),
    'a trait method was reported as private',
  );
  assert.equal(find(symbols, 'inherent_private').exported, false, 'an inherent impl method needs pub to be public');
});

test('markdown: headings nest and own the text beneath them', () => {
  const source = ['# Title', 'intro', '## First', 'body', '## Second', 'more', '# Next'].join('\n');
  const symbols = extractSymbols(source, 'markdown');

  const title = find(symbols, 'Title');
  assert.equal(title.depth, 0);
  assert.equal(title.endLine, 6);

  const first = find(symbols, 'First');
  assert.equal(first.depth, 1);
  assert.equal(first.endLine, 4);
});

test('markdown: headings inside fenced code are not symbols', () => {
  const source = ['# Real', '```', '# Fake', '```'].join('\n');
  const names = extractSymbols(source, 'markdown').map((s) => s.name);
  assert.deepEqual(names, ['Real']);
});

test('unknown languages yield no symbols rather than throwing', () => {
  assert.deepEqual(extractSymbols('anything at all', 'text'), []);
});

test('empty input yields no symbols', () => {
  assert.deepEqual(extractSymbols('', 'typescript'), []);
});
