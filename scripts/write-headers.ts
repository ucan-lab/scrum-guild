// pnpm build の最後に動かし、build/index.html の CSP の meta から build/_headers を書く。
// meta が見つからないとき、書き出した JS の style 属性が CSP で止まるときは失敗で終える（壊れた画面を配らないため）。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractMetaCsp, headersFile, missingStyleHashes } from './headers.ts';

try {
  const html = readFileSync('build/index.html', 'utf8');
  const scripts = readdirSync('build/_app', { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.js'))
    .map((file) => readFileSync(path.join('build/_app', file), 'utf8'));
  const missing = missingStyleHashes(extractMetaCsp(html), scripts);
  if (missing.length > 0) {
    throw new Error(
      `CSP の style-src に無い style 属性がある。src/shared/security-headers.ts に足す:\n${missing.join('\n')}`,
    );
  }
  writeFileSync('build/_headers', headersFile(html));
} catch (err) {
  console.error(`build/_headers を書けませんでした: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
