import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { build } from 'vite';
import viteConfig from '../vite.config.ts';
import { decodeNamedCharacterReferenceFile } from './markdown-worker-entities.ts';

const root = path.resolve(import.meta.dirname, '..');

describe('decodeNamedCharacterReferenceFile', () => {
  test('DOM を使わない index.js を指す', () => {
    assert.equal(path.basename(decodeNamedCharacterReferenceFile), 'index.js');
    assert.doesNotMatch(readFileSync(decodeNamedCharacterReferenceFile, 'utf8'), /\bdocument\b/);
  });

  // vite.config.ts の alias を外すと、browser の条件で DOM 版が選ばれ、Worker が `document is not defined` で落ちる。
  // 部品を載せた画面がまだ無いと本番の build に Worker の束が出ないので、ここで Worker の入口を同じ resolve で束ねて確かめる
  test('vite.config.ts の resolve で Worker を束ねると、document を使わない', { timeout: 60_000 }, async () => {
    const output = (await build({
      configFile: false,
      root,
      logLevel: 'silent',
      resolve: { ...viteConfig.resolve, conditions: ['browser', 'module', 'import', 'default'] },
      build: {
        write: false,
        minify: false,
        lib: { entry: path.join(root, 'src/lib/markdown.worker.ts'), formats: ['es'], fileName: 'markdown.worker' },
      },
    })) as { output: { type: string; code?: string }[] }[];
    const code = output
      .flatMap((result) => result.output)
      .map((chunk) => (chunk.type === 'chunk' ? (chunk.code ?? '') : ''))
      .join('\n');
    // DOM を使わない版は、名前つきの文字参照の表（character-entities）を束に持つ
    assert.match(code, /\bAElig\b/, '束に文字参照の表が入っていない（束ね方が変わったら、この確かめ方も直す）');
    assert.doesNotMatch(code, /\bdocument\.createElement\b/);
  });
});
