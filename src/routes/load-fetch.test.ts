// src/routes の load（+page.ts と +layout.ts）が、API を SvelteKit の渡す fetch で呼ぶことを、ソースの AST で確かめる（Issue #393）。
// 開発モードの build では SvelteKit が load の中の window.fetch をスタックで見分けられず、load の間に画面の部品が送った操作も
// window_fetch_in_load として警告する。そのため e2e ではこの警告を数えず（scripts/dev-warnings.ts）、load の側はこのテストで確かめる。
// 落とすもの:
//   - callOperation(...) の3番目の引数が無いか、その object の fetcher が load の引数の fetch でない。
//     3番目の引数が識別子なら、同じファイルの変数宣言の object literal を辿る。辿れない形は落とす
//   - getHealth(...) の1番目の引数が load の引数の fetch でない（今は load から呼ぶものは無い。+page.svelte だけが呼ぶ）
//   - callOperation と getHealth を、別名や名前空間で取り込む（上の検査に当たらなくなる）
//   - window.fetch、globalThis.fetch、self.fetch と、load の引数で受けていない fetch の呼び出し
//   - load の引数の fetch を、fetcher と getHealth と直接の呼び出しのほかへ渡す（包んだ関数の中で使われるかを確かめられない）
// 確かめられないもの: load が $lib の関数を呼び、その関数の中で fetcher 無しの callOperation を使う書き方。load から API を
// 呼ぶときは、callOperation か getHealth か fetch を load の中で直に呼ぶ
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const routesDir = fileURLToPath(new URL('.', import.meta.url));
// +page.ts と +layout.ts のほか、レイアウトを飛ばす名前（+page@.ts など）と .js も拾う
const LOAD_FILE = /^\+(page|layout)(@[^.]*)?\.(ts|js)$/;

function loadFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...loadFiles(path));
    else if (LOAD_FILE.test(entry.name)) files.push(path);
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

// 識別子 fetch が、宣言の名前（`{ fetch }` の分割代入）か、プロパティの名前（`window.fetch` の fetch、`{ fetch: … }` の fetch）か
function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (
    (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node)
  );
}

function isCallee(node: ts.Identifier): boolean {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
}

function isFetcherValue(node: ts.Expression): boolean {
  const parent = node.parent;
  return (
    ts.isPropertyAssignment(parent) &&
    parent.initializer === node &&
    ts.isIdentifier(parent.name) &&
    parent.name.text === 'fetcher'
  );
}

function isGetHealthArgument(node: ts.Expression): boolean {
  const parent = node.parent;
  return (
    ts.isCallExpression(parent) &&
    ts.isIdentifier(parent.expression) &&
    parent.expression.text === 'getHealth' &&
    parent.arguments[0] === node
  );
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
    // callOperation と getHealth を別名や名前空間で取り込むと、下の名前の検査に当たらない
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const fromApi = /lib\/api(\.ts)?$/.test(node.moduleSpecifier.text);
      const bindings = node.importClause?.namedBindings;
      const aliased =
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.some(
          (element) =>
            element.propertyName !== undefined &&
            ['callOperation', 'getHealth'].includes(element.propertyName.text) &&
            element.name.text !== element.propertyName.text,
        );
      if (fromApi && ((bindings !== undefined && ts.isNamespaceImport(bindings)) || aliased)) {
        report(node, 'callOperation と getHealth は lib/api.ts からそのままの名前で取り込む');
      }
    }
    // window.fetch などのグローバルの fetch は、load の間に呼ぶと SvelteKit の fetch を通らない
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'fetch' &&
      ts.isIdentifier(node.expression) &&
      ['window', 'globalThis', 'self'].includes(node.expression.text) &&
      // fetcher と getHealth に渡したものは、下の callOperation と getHealth の検査が挙げる
      !isFetcherValue(node) &&
      !isGetHealthArgument(node)
    ) {
      report(node, 'グローバルの fetch でなく、load の引数の fetch を使う');
    }
    if (ts.isIdentifier(node) && node.text === 'fetch' && !isDeclarationName(node)) {
      if (!isLoadFetch(node)) {
        if (isCallee(node)) report(node, 'グローバルの fetch でなく、load の引数の fetch を使う');
      } else if (!isCallee(node) && !isFetcherValue(node) && !isGetHealthArgument(node)) {
        // 包んだ関数に渡すと、その中で使われるかを確かめられない
        report(node, 'load の引数の fetch は、fetcher と getHealth と直接の呼び出しのほかへ渡さない');
      }
    }
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
  const options = makeOptions(params);
  return callOperation(x, {}, options);
};`;
    for (const code of [imported, notObject]) {
      expect(checkLoadFetch(code).problems).toEqual([expect.stringMatching(/辿れない/)]);
    }
  });

  test('callOperation と getHealth を別名や名前空間で取り込むものを落とす（検査に当たらなくなるため）', () => {
    const aliased = `import { callOperation as call } from '$lib/api.ts';
export const load = async ({ fetch }) => call(x, {});`;
    const namespaced = `import * as api from '../../lib/api.ts';
export const load = async ({ fetch }) => api.callOperation(x, {});`;
    for (const code of [aliased, namespaced]) {
      expect(checkLoadFetch(code).problems).toEqual([expect.stringMatching(/そのままの名前で取り込む/)]);
    }
  });

  test('window.fetch と globalThis.fetch を落とす', () => {
    for (const target of ['window.fetch', 'globalThis.fetch', 'self.fetch']) {
      const code = `${head}export const load = async ({ fetch }) => ${target}('/api/aoba/x');`;
      expect(checkLoadFetch(code).problems).toEqual([expect.stringMatching(/load の引数の fetch を使う/)]);
    }
  });

  test('load の引数の fetch を、fetcher と getHealth のほかへ渡すものを落とす（包んだ関数の中で使われるか分からないため）', () => {
    const code = `${head}import { readAll } from '$lib/read-all.ts';
export const load = async ({ fetch }) => readAll(fetch);`;
    expect(checkLoadFetch(code).problems).toEqual([expect.stringMatching(/ほかへ渡さない/)]);
  });

  test('load の引数の fetch をそのまま呼ぶのは通す', () => {
    const code = `export const load = async ({ fetch }) => fetch('/api/health');`;
    expect(checkLoadFetch(code)).toEqual({ calls: 0, problems: [] });
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
