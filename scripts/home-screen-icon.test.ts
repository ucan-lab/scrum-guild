import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../static/manifest.webmanifest', import.meta.url), 'utf8')) as {
  icons: { src: string; sizes: string; type: string; purpose: string }[];
};
const appHtml = readFileSync(new URL('../src/app.html', import.meta.url), 'utf8');

function pngSize(path: string): [number, number] {
  const png = readFileSync(new URL(`../static${path}`, import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${path} は PNG ではない`);
  assert.equal(png.readUInt32BE(8), 13, `${path} の IHDR が不正`);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR', `${path} に IHDR がない`);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

describe('ホーム画面アイコン', () => {
  test('マニフェストが指す PNG は宣言どおりの大きさで static/ にある', () => {
    assert.equal(manifest.icons.length, 2);
    for (const icon of manifest.icons) {
      assert.match(icon.src, /^\/(?:icon-192|icon-512)\.png$/);
      assert.equal(icon.type, 'image/png');
      assert.equal(icon.purpose, 'any');
      const declaredSize = Number.parseInt(icon.sizes, 10);
      assert.deepEqual(pngSize(icon.src), [declaredSize, declaredSize], icon.src);
    }
  });

  test('app.html が apple-touch-icon とマニフェストを参照する', () => {
    assert.match(appHtml, /<link rel="apple-touch-icon" href="%sveltekit\.assets%\/apple-touch-icon\.png" \/>/);
    assert.match(appHtml, /<link rel="manifest" href="%sveltekit\.assets%\/manifest\.webmanifest" \/>/);
  });
});
