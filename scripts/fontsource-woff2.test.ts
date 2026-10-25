import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { dropWoff, fontsourceWoff2Only } from './fontsource-woff2.ts';

const face = `@font-face {
  font-family: 'BIZ UDPGothic';
  font-weight: 400;
  src: url(./files/biz-udpgothic-0-400-normal.woff2) format('woff2'), url(./files/biz-udpgothic-0-400-normal.woff) format('woff');
  unicode-range: U+25ee8,U+25f23;
}`;

describe('fontsource の woff を外す', () => {
  test('src から woff だけを外し、woff2 と unicode-range を残す', () => {
    const out = dropWoff(face);
    assert.match(out, /src: url\(\.\/files\/biz-udpgothic-0-400-normal\.woff2\) format\('woff2'\);/);
    assert.doesNotMatch(out, /\.woff\)/);
    assert.match(out, /unicode-range: U\+25ee8,U\+25f23;/);
  });

  test('実際の @fontsource の CSS でも woff が残らない', () => {
    for (const file of [
      'biz-udpgothic/400.css',
      'zen-old-mincho/900.css',
      'ibm-plex-mono/500.css',
      'chakra-petch/600.css',
    ]) {
      const css = readFileSync(new URL(`../node_modules/@fontsource/${file}`, import.meta.url), 'utf8');
      assert.match(css, /\.woff\) format\('woff'\)/, `${file} に woff がある前提が変わった`);
      const out = dropWoff(css);
      assert.doesNotMatch(out, /\.woff\)/, file);
      assert.match(out, /\.woff2\) format\('woff2'\)/, file);
    }
  });

  test('プラグインは @fontsource の CSS だけを書き換える', () => {
    const plugin = fontsourceWoff2Only();
    const transform = plugin.transform as (code: string, id: string) => { code: string } | null;
    assert.equal(
      transform.call({}, face, '/repo/node_modules/@fontsource/biz-udpgothic/400.css')?.code.includes('.woff)'),
      false,
    );
    assert.equal(transform.call({}, face, '/repo/design/components.css'), null);
    assert.equal(transform.call({}, face, '/repo/node_modules/@fontsource/biz-udpgothic/index.js'), null);
  });
});
