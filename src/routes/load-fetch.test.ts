// src/routes の load（+page.ts と +layout.ts）が、API を SvelteKit の渡す fetch で呼ぶことを、ソースの AST で確かめる（Issue #393）。
// 開発モードの build では SvelteKit が load の中の window.fetch をスタックで見分けられず、load の間に画面の部品が送った操作も
// window_fetch_in_load として警告する。そのため e2e ではこの警告を数えず（scripts/dev-warnings.ts）、load の側はこのテストで確かめる。
// 落とすもの:
//   - callOperation(...) の3番目の引数が無いか、その object の fetcher が load の引数の fetch でない。
//     3番目の引数が識別子なら、同じファイルの変数宣言の object literal を辿る。辿れない形は落とす
//   - getHealth(...) の1番目の引数が load の引数の fetch でない
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const routesDir = fileURLToPath(new URL('.', import.meta.url));
const LOAD_FILES = new Set(['+page.ts', '+layout.ts']);

function loadFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...loadFiles(path));
    else if (LOAD_FILES.has(entry.name)) files.push(path);
  }
  return files;
}

type LoadFetchResult = { calls: number; problems: string[] };

// 識別子 fetch が、囲む関数の1番目の引数の分割代入（`{ fetch }`）で受けたものか。受けていなければ window.fetch になる
function isLoadFetch(node: ts.Expression): boolean {
  if (!ts.isIdentifier(node) || node.text !== 'fetch') return false;
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const first = current.parameters[0];
    if (first === undefined || !ts.isObjectBindingPattern(first.name)) continue;
    const bound = first.name.elements.some(
      (element) =>
        ts.isIdentifier(element.name) &&
        element.name.text === 'fetch' &&
        (element.propertyName === undefined ||
          (ts.isIdentifier(element.propertyName) && element.propertyName.text === 'fetch')),
    );
    if (bound) return true;
  }
  return false;
}

// 3番目の引数の object literal を返す。識別子なら、同じファイルでその名前を宣言した、ただ1つの変数の初期値を辿る
function optionsObject(source: ts.SourceFile, arg: ts.Expression): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(arg)) return arg;
  if (!ts.isIdentifier(arg)) return undefined;
  const declarations: ts.VariableDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === arg.text) {
      declarations.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const [declaration] = declarations;
  if (declarations.length !== 1 || declaration?.initializer === undefined) return undefined;
  return ts.isObjectLiteralExpression(declaration.initializer) ? declaration.initializer : undefined;
}

function fetcherOf(object: ts.ObjectLiteralExpression): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'fetcher') {
      return property.initializer;
    }
  }
  return undefined;
}

function checkLoadFetch(code: string, fileName = 'load.ts'): LoadFetchResult {
  const source = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const problems: string[] = [];
  let calls = 0;
  const report = (node: ts.Node, message: string) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    problems.push(`${fileName}:${line + 1}: ${message}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === 'callOperation') {
        calls += 1;
        const arg = node.arguments[2];
        const object = arg === undefined ? undefined : optionsObject(source, arg);
        const fetcher = object === undefined ? undefined : fetcherOf(object);
        if (arg === undefined) report(node, 'callOperation に3番目の引数（{ fetcher: fetch }）が無い');
        else if (object === undefined)
          report(node, 'callOperation の3番目の引数を、同じファイルの object literal まで辿れない');
        else if (fetcher === undefined || !isLoadFetch(fetcher)) {
          report(node, 'callOperation の fetcher が load の引数の fetch でない');
        }
      } else if (name === 'getHealth') {
        calls += 1;
        const arg = node.arguments[0];
        if (arg === undefined || !isLoadFetch(arg))
          report(node, 'getHealth の1番目の引数が load の引数の fetch でない');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { calls, problems };
}

describe('checkLoadFetch', () => {
  const head = "import { callOperation, getHealth } from '$lib/api.ts';\n";

  test('object literal の fetcher: fetch は通る', () => {
    const code = `${head}export const load = async ({ params, fetch }) => callOperation(x, {}, { slug: params.slug, fetcher: fetch });`;
    expect(checkLoadFetch(code)).toEqual({ calls: 1, problems: [] });
  });

  test('同じファイルの変数の object literal を辿って通す', () => {
    const code = `${head}export const load = async ({ params, fetch }) => {
  const options = { slug: params.slug, fetcher: fetch };
  return Promise.all([callOperation(a, {}, options), callOperation(b, {}, options)]);
};`;
    expect(checkLoadFetch(code)).toEqual({ calls: 2, problems: [] });
  });

  test('getHealth(fetch) は通る', () => {
    const code = `${head}export const load = async ({ fetch }) => getHealth(fetch);`;
    expect(checkLoadFetch(code)).toEqual({ calls: 1, problems: [] });
  });

  test('3番目の引数が無いものを落とす', () => {
    const code = `${head}export const load = async ({ fetch }) => callOperation(x, {});`;
    expect(checkLoadFetch(code).problems).toEqual([expect.stringMatching(/3番目の引数.*が無い/)]);
  });

  test('fetcher が無い object を落とす', () => {
    const code = `${head}export const load = async ({ params, fetch }) => callOperation(x, {}, { slug: params.slug });`;
    expect(checkLoadFetch(code).problems).toEqual([expect.stringMatching(/fetcher が load の引数の fetch でない/)]);
  });

  test('fetcher: window.fetch を落とす', () => {
    const code = `${head}export const load = async ({ fetch }) => callOperation(x, {}, { fetcher: window.fetch });`;
    expect(checkLoadFetch(code).problems).toHaveLength(1);
  });

  test('load の引数で受けていない fetch（window.fetch になる）を落とす', () => {
    const code = `${head}export const load = async ({ params }) => callOperation(x, {}, { fetcher: fetch });`;
    expect(checkLoadFetch(code).problems).toHaveLength(1);
  });

  test('辿れない識別子を落とす', () => {
    const imported = `${head}import { options } from './options.ts';
export const load = async ({ fetch }) => callOperation(x, {}, options);`;
    const notObject = `${head}export const load = async ({ fetch }) => {
  const options = makeOptions(fetch);
  return callOperation(x, {}, options);
};`;
    for (const code of [imported, notObject]) {
      expect(checkLoadFetch(code).problems).toEqual([expect.stringMatching(/辿れない/)]);
    }
  });

  test('getHealth() の引数が無いものと、fetch でないものを落とす', () => {
    expect(checkLoadFetch(`${head}export const load = async ({ fetch }) => getHealth();`).problems).toHaveLength(1);
    expect(
      checkLoadFetch(`${head}export const load = async ({ fetch }) => getHealth(window.fetch);`).problems,
    ).toHaveLength(1);
  });
});

describe('src/routes の load', () => {
  test('callOperation と getHealth を、load の引数の fetch で呼ぶ', () => {
    const files = loadFiles(routesDir);
    // 見つけられないときに、何も確かめずに通らないため
    expect(files.length).toBeGreaterThan(0);
    const results = files.map((file) =>
      checkLoadFetch(readFileSync(file, 'utf8'), relative(routesDir, file).split(sep).join('/')),
    );
    expect(results.reduce((sum, { calls }) => sum + calls, 0)).toBeGreaterThan(0);
    expect(results.flatMap(({ problems }) => problems)).toEqual([]);
  });
});
