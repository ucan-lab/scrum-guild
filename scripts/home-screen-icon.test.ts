import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

type ManifestIcon = { src: string; sizes: string; type: string; purpose: string };

const manifest = JSON.parse(readFileSync(new URL('../static/manifest.webmanifest', import.meta.url), 'utf8')) as {
  icons: ManifestIcon[];
};
const appHtml = readFileSync(new URL('../src/app.html', import.meta.url), 'utf8');

// IHDR の colortype。0 と 2 はアルファが無い。4 と 6 はアルファがあり、iOS は透明部分を黒で塗る
const OPAQUE_COLOR_TYPES = [0, 2];

function readPng(path: string): Buffer {
  const png = readFileSync(new URL(`../static${path}`, import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${path} は PNG ではない`);
  assert.equal(png.readUInt32BE(8), 13, `${path} の IHDR が不正`);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR', `${path} に IHDR がない`);
  return png;
}

function pngSize(path: string): [number, number] {
  const png = readPng(path);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

// app.html の <link> の href を、static/ からの絶対パス（/apple-touch-icon.png）で返す
function linkHref(rel: string): string {
  const tag = new RegExp(`<link\\s[^>]*rel="${rel}"[^>]*>`).exec(appHtml)?.[0];
  assert.ok(tag, `app.html に rel="${rel}" の link がない`);
  const href = /href="%sveltekit\.assets%(\/[^"]+)"/.exec(tag)?.[1];
  assert.ok(href, `rel="${rel}" の href を読めない`);
  return href;
}

describe('ホーム画面アイコン', () => {
  test('マニフェストの各アイコンは、宣言どおりの大きさの PNG で static/ にある', () => {
    assert.ok(manifest.icons.length > 0);
    for (const icon of manifest.icons) {
      assert.equal(icon.type, 'image/png');
      const declaredSize = Number.parseInt(icon.sizes, 10);
      assert.deepEqual(pngSize(icon.src), [declaredSize, declaredSize], icon.src);
    }
  });

  test('マニフェストは 192 と 512 のアイコンを any と maskable の両方で宣言する', () => {
    for (const purpose of ['any', 'maskable']) {
      const sizes = manifest.icons.filter((icon) => icon.purpose === purpose).map((icon) => icon.sizes);
      assert.deepEqual(sizes.sort(), ['192x192', '512x512'], `purpose ${purpose}`);
    }
  });

  test('app.html の apple-touch-icon は、static/ にある 180px の PNG を指す', () => {
    assert.deepEqual(pngSize(linkHref('apple-touch-icon')), [180, 180]);
  });

  test('app.html のマニフェストの link は、static/ にあるマニフェストを指す', () => {
    assert.equal(linkHref('manifest'), '/manifest.webmanifest');
  });

  test('ホーム画面の PNG は不透明（iOS が透明部分を黒で塗らない）', () => {
    const paths = [linkHref('apple-touch-icon'), ...manifest.icons.map((icon) => icon.src)];
    for (const path of paths) {
      const png = readPng(path);
      assert.ok(OPAQUE_COLOR_TYPES.includes(png[25]), `${path} の colortype ${png[25]} は透明を含みうる`);
    }
  });

  test('テーマに追従できない固定の theme-color の meta を置かない', () => {
    assert.doesNotMatch(appHtml, /<meta\s[^>]*name="theme-color"/);
  });

  test('iOS の追加時の名前を画面の題名に任せず、固定する', () => {
    assert.match(appHtml, /<meta\s[^>]*name="apple-mobile-web-app-title"/);
  });
});
