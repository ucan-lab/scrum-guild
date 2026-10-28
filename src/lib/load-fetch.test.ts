// 画面の load（src/routes の +page.ts と +layout.ts）が、API を load に渡された fetch で読むことを、書いたコードから確かめる（#429）。
// SvelteKit は開発時に、load の中の window.fetch を window_fetch_in_load の警告で知らせるが、build した画面ではその判定が働かず、
// 開発モードの build の e2e はこの警告を数えない（scripts/dev-warnings.ts の UNJUDGEABLE_DEV_WARNINGS）。このテストがその代わりになる。
// 通す書き方は、load の1つ目の引数の分割で受けた fetch を、callOperation の3つ目の引数の `fetcher: fetch`（その場の入れ物か、
// 名前を付けた入れ物）と getHealth の引数に渡すものだけ。`{ fetch: f }` や `event.fetch` のような書き方は、正しくても断る
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const routesDir = fileURLToPath(new URL('../routes', import.meta.url));
const libDir = fileURLToPath(new URL('.', import.meta.url));
const API_MODULE = join(libDir, 'api.ts');

// load のファイルが値を import する src/lib のモジュール（api.ts を除く）の絶対パス
function importedLibModules(source: string, path: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const modules: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.importClause?.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const module = resolve(dirname(path), specifier);
    if (module.startsWith(libDir) && module !== API_MODULE) modules.push(module);
  }
  return modules;
}
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

  // api.ts から import した名前（別名を含む）と、名前空間の import の名前
  const aliases = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!/(^|\/)lib\/api\.ts$/.test(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        aliases.set(element.name.text, (element.propertyName ?? element.name).text);
      }
    }
  }
  const calleeOf = (expression: ts.Expression): string | undefined => {
    if (ts.isIdentifier(expression)) return aliases.get(expression.text) ?? expression.text;
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      return namespaces.has(expression.expression.text) ? expression.name.text : undefined;
    }
    return undefined;
  };
  // 値として読む fetch か（プロパティの名前、分割の名前、import の名前、`window.fetch` の右は除く）
  const isFetchValue = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
    if (ts.isBindingElement(parent)) return false;
    if (ts.isImportSpecifier(parent)) return false;
    return true;
  };

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
    if (ts.isCallExpression(node)) {
      const callee = calleeOf(node.expression);
      if (callee === 'callOperation') {
        const fetcher = fetcherOf(node.arguments[2]);
        if (fetcher === undefined || !isLoadFetch(fetcher))
          report(node, 'callOperation の fetcher に load の fetch を渡していない');
      } else if (callee === 'getHealth') {
        const fetcher = node.arguments[0];
        if (fetcher === undefined || !isLoadFetch(fetcher)) report(node, 'getHealth に load の fetch を渡していない');
      }
    }
    if (ts.isIdentifier(node) && node.text === 'fetch' && isFetchValue(node) && !isLoadFetch(node)) {
      report(node, 'load の fetch でない fetch を使っている');
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
      '3: load の fetch でない fetch を使っている',
      '4: load の fetch でない fetch を使っている',
      '6: getHealth に load の fetch を渡していない',
      '6: load の fetch でない fetch を使っている',
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

  test('別名と名前空間で import した callOperation と getHealth も見る', () => {
    expect(
      loadFetchViolations(`
        import { callOperation as call, getHealth as health } from '../lib/api.ts';
        import * as api from '../lib/api.ts';
        export const load = async ({ fetch }) => {
          await call(a, {}, {});
          await health();
          await api.callOperation(b, {}, {});
          await api.callOperation(c, {}, { fetcher: fetch });
        };`),
    ).toEqual([
      '5: callOperation の fetcher に load の fetch を渡していない',
      '6: getHealth に load の fetch を渡していない',
      '7: callOperation の fetcher に load の fetch を渡していない',
    ]);
  });

  test('load の fetch でない fetch は、呼ばずに値として渡しても断る', () => {
    expect(
      loadFetchViolations(`
        export const load = async ({ params }) => {
          const f = fetch;
          await Promise.all(urls.map(fetch));
        };`),
    ).toEqual(['3: load の fetch でない fetch を使っている', '4: load の fetch でない fetch を使っている']);
  });
});

describe('importedLibModules', () => {
  test('src/lib の下を相対の指定で import したモジュールを返し、api.ts と型だけの import は除く', () => {
    const from = join(routesDir, '[slug]', '+layout.ts');
    expect(
      importedLibModules(
        `
        import { callOperation } from '../../lib/api.ts';
        import { loginUrl } from '../../lib/login-redirect.ts';
        import type { WorkspaceView } from '../../lib/workspace.ts';
        import { redirect } from '@sveltejs/kit';
        import { x } from '../../shared/x.ts';`,
        from,
      ),
    ).toEqual([join(libDir, 'login-redirect.ts')]);
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

  // load から呼ぶ src/lib の関数の中は追わない。代わりに、load が import する src/lib のモジュール（api.ts を除く）は API を読まない、とする。
  // load の中で API を読むのは、load のファイルに直に書いた callOperation と getHealth だけにする
  test.each(files.map((path) => [relative(routesDir, path), path]))(
    '%s が import する src/lib のモジュールは API を読まない',
    (_, path) => {
      for (const module of importedLibModules(readFileSync(path, 'utf8'), path)) {
        expect(readFileSync(module, 'utf8'), relative(libDir, module)).not.toMatch(
          /\b(callOperation|getHealth|fetch)\b/,
        );
      }
    },
  );
});
