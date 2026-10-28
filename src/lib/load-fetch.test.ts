// 画面の load（src/routes の +page.ts と +layout.ts）が、API を load に渡された fetch で読むことを、書いたコードから確かめる（#429）。
// SvelteKit は開発時に、load の中の window.fetch を window_fetch_in_load の警告で知らせるが、build した画面ではその判定が働かず、
// 開発モードの build の e2e はこの警告を数えない（scripts/dev-warnings.ts の UNJUDGEABLE_DEV_WARNINGS）。その代わりの確かめ
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const routesDir = fileURLToPath(new URL('../routes', import.meta.url));
const LOAD_FILE = /^\+(page|layout)\.ts$/;

function loadFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...loadFiles(path));
    else if (LOAD_FILE.test(entry.name)) files.push(path);
  }
  return files;
}

// fetch が、囲む関数の1つ目の引数の分割（`async ({ fetch }) => ...`）で受けたものか。受けていなければ window.fetch を指す
function isLoadFetch(node: ts.Node): boolean {
  if (!ts.isIdentifier(node) || node.text !== 'fetch') return false;
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (!ts.isFunctionLike(current)) continue;
    const first = current.parameters[0]?.name;
    if (
      first !== undefined &&
      ts.isObjectBindingPattern(first) &&
      first.elements.some(
        (element) =>
          ts.isIdentifier(element.name) &&
          element.name.text === 'fetch' &&
          (element.propertyName === undefined ||
            (ts.isIdentifier(element.propertyName) && element.propertyName.text === 'fetch')),
      )
    ) {
      return true;
    }
  }
  return false;
}

// load の中で、load の fetch を使わずに API を読む書き方を、行の番号と並べて返す
function loadFetchViolations(source: string, fileName = '+page.ts'): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const objects = new Map<string, ts.ObjectLiteralExpression>();
  const violations: string[] = [];
  const report = (node: ts.Node, message: string) =>
    violations.push(`${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${message}`);

  // `const options = { fetcher: fetch }` のように、名前を付けた入れ物も読む
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      objects.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(file);

  const fetcherOf = (options: ts.Expression | undefined): ts.Expression | undefined => {
    const object =
      options === undefined
        ? undefined
        : ts.isObjectLiteralExpression(options)
          ? options
          : ts.isIdentifier(options)
            ? objects.get(options.text)
            : undefined;
    const property = object?.properties.find(
      (p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === 'fetcher',
    );
    return property !== undefined && ts.isPropertyAssignment(property) ? property.initializer : undefined;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if (callee === 'callOperation') {
        const fetcher = fetcherOf(node.arguments[2]);
        if (fetcher === undefined || !isLoadFetch(fetcher))
          report(node, 'callOperation の fetcher に load の fetch を渡していない');
      } else if (callee === 'getHealth') {
        const fetcher = node.arguments[0];
        if (fetcher === undefined || !isLoadFetch(fetcher)) report(node, 'getHealth に load の fetch を渡していない');
      } else if (callee === 'fetch' && !isLoadFetch(node.expression)) {
        report(node, 'load の fetch でない fetch を呼んでいる');
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'fetch' &&
      ts.isIdentifier(node.expression) &&
      ['window', 'globalThis', 'self'].includes(node.expression.text)
    ) {
      report(node, `${node.expression.text}.fetch を使っている`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

describe('loadFetchViolations', () => {
  test('load の fetch を、その場の入れ物か名前を付けた入れ物で渡せば通す', () => {
    expect(
      loadFetchViolations(`
        export const load = async ({ params, fetch }) => {
          const options = { slug: params.slug, fetcher: fetch };
          await callOperation(a, {}, { slug: params.slug, fetcher: fetch });
          await callOperation(b, {}, options);
          await getHealth(fetch);
          await fetch('/api/health');
        };`),
    ).toEqual([]);
  });

  test('fetcher を渡さない、別の値を渡す呼び方を断る', () => {
    expect(
      loadFetchViolations(`
        export const load = async ({ params, fetch }) => {
          await callOperation(a, {}, { slug: params.slug });
          await callOperation(b, {});
          await callOperation(c, {}, { fetcher: window.fetch });
          await callOperation(d, {}, { fetcher: other });
          await getHealth();
        };`),
    ).toEqual([
      '3: callOperation の fetcher に load の fetch を渡していない',
      '4: callOperation の fetcher に load の fetch を渡していない',
      '5: callOperation の fetcher に load の fetch を渡していない',
      '5: window.fetch を使っている',
      '6: callOperation の fetcher に load の fetch を渡していない',
      '7: getHealth に load の fetch を渡していない',
    ]);
  });

  test('load が fetch を受けていなければ、fetch は window.fetch なので断る', () => {
    expect(
      loadFetchViolations(`
        export const load = async ({ params }) => {
          await callOperation(a, {}, { slug: params.slug, fetcher: fetch });
          await fetch('/api/health');
        };
        export const other = async ({ fetch: f }) => getHealth(fetch);`),
    ).toEqual([
      '3: callOperation の fetcher に load の fetch を渡していない',
      '4: load の fetch でない fetch を呼んでいる',
      '6: getHealth に load の fetch を渡していない',
    ]);
  });

  test('globalThis.fetch と self.fetch も断る', () => {
    expect(
      loadFetchViolations(`
        export const load = async ({ fetch }) => {
          await globalThis.fetch('/api/health');
          await self.fetch('/api/health');
        };`),
    ).toEqual(['3: globalThis.fetch を使っている', '4: self.fetch を使っている']);
  });
});

describe('src/routes の load', () => {
  const files = loadFiles(routesDir);

  test('+page.ts と +layout.ts を見つける（空振りしない）', () => {
    expect(files.filter((path) => readFileSync(path, 'utf8').includes('callOperation(')).length).toBeGreaterThan(5);
  });

  test.each(files.map((path) => [relative(routesDir, path), path]))(
    '%s は API を load の fetch で読む',
    (name, path) => {
      expect(loadFetchViolations(readFileSync(path, 'utf8'), name)).toEqual([]);
    },
  );
});
