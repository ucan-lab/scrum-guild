// CLI は別のリポジトリへ出せるよう src/ を import しない。main.ts は Workers のテストからも呼ぶので node の組み込みを import しない
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cliDir = fileURLToPath(new URL('..', import.meta.url));

function sourcesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourcesIn(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

// import と export from と import() の指定子
function specifiersOf(source: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;
  return [...source.matchAll(pattern)].map((match) => match[1]!);
}

test('cli/ のコードは src/ を import しない', () => {
  const sources = sourcesIn(cliDir);
  assert.ok(
    sources.some((path) => path.endsWith(join('lib', 'main.ts'))),
    'main.ts を見つける',
  );
  for (const path of sources) {
    for (const specifier of specifiersOf(readFileSync(path, 'utf8'))) {
      assert.ok(!/(^|\/)src\//.test(specifier), `${relative(cliDir, path)} が ${specifier} を import している`);
    }
  }
});

test('cli/lib/main.ts は node の組み込みを import しない', () => {
  const specifiers = specifiersOf(readFileSync(join(cliDir, 'lib', 'main.ts'), 'utf8'));
  for (const specifier of specifiers) {
    assert.ok(!specifier.startsWith('node:'), specifier);
  }
});
