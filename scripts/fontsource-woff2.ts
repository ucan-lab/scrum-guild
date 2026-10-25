// @fontsource の CSS は、src に woff2 と woff の両方を書く。woff2 はどのブラウザでも読めるので、使われない woff は
// build に出さない（日本語の書体は文字の範囲ごとに約250ファイルあり、woff が同じ数だけ増える）。
// vite.config.ts が Vite のプラグインとして読み、scripts/fontsource-woff2.test.ts が置き換えを確かめる。
import type { Plugin } from 'vite';

const woffSource = /,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g;

export function dropWoff(css: string): string {
  return css.replace(woffSource, '');
}

export function fontsourceWoff2Only(): Plugin {
  return {
    name: 'fontsource-woff2-only',
    // CSS を Vite が url() の解決とファイルへの書き出しにかける前（pre）に、src から woff を外す
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0];
      if (!file.endsWith('.css') || !file.includes('/@fontsource/')) return null;
      return { code: dropWoff(code), map: null };
    },
  };
}
