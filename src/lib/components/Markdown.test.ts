import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, test } from 'vitest';
import { parseMarkdown } from '../markdown.ts';
import Markdown from './Markdown.svelte';
import MarkdownBlocks from './MarkdownBlocks.svelte';
import MarkdownPlain from './MarkdownPlain.svelte';

// svelte/server の出力には、ハイドレーション用のコメントと、要素の間の空白が入る。要素と属性だけを見るため外す
const withoutComments = (body: string) =>
  body
    .replace(/<!--.*?-->/g, '')
    .replace(/>\s+</g, '><')
    .trim();
// 変換済みの節を描く部分。変換は Worker で行うので、ここでは parseMarkdown の結果を直に渡す
const html = (source: string, headingStart?: number) => {
  const blocks = parseMarkdown(source);
  if (blocks === null) throw new Error('変換が上限で止まった');
  return withoutComments(render(MarkdownBlocks, { props: { blocks, headingStart } }).body);
};

const tagsOf = (out: string) => [...out.matchAll(/<([a-z][a-z0-9]*)/gi)].map((m) => m[1]);
const attributesOf = (out: string) => [...out.matchAll(/<[a-z][a-z0-9]*\s([^>]*)>/gi)].map((m) => m[1]);

describe('Markdown.svelte の悪い入力', () => {
  test.each([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    'a <img src=x onerror=alert(1)> b',
    '<a href="javascript:alert(1)">x</a>',
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](java\tscript:alert(1))',
    '[x](data:text/html;base64,AAAA)',
    '<div style="x">y</div>',
    '<iframe src="https://example.com"></iframe>',
    '![x](javascript:alert(1))',
    '![x](data:image/svg+xml;base64,AAAA)',
    '[a](/aoba/w/1?task=2) [b](mailto:a@example.com)',
    '[x](https://user@evil.example/)',
  ])('%s は要素や属性として出ない', (source) => {
    const out = html(source);
    // 本文が文字なら、開始タグは枠の div、段落の p、書かれたままの文字と補足の span だけで、属性は class と補足の id だけになる
    for (const tag of tagsOf(out)) expect(['div', 'p', 'span']).toContain(tag);
    for (const attributes of attributesOf(out)) {
      expect(attributes).toMatch(/^(class="(doc-box|doc-literal)"|id="[^"]+-newtab" hidden="")$/);
    }
  });

  test('生の HTML は文字として出る', () => {
    expect(html('<script>alert(1)</script>')).toContain('&lt;script>alert(1)&lt;/script>');
  });

  test('外部の画像は img でなくリンクとして出る', () => {
    const out = html('![x](https://example.com/a.png)');
    expect(out).not.toContain('<img');
    expect(out).toMatch(
      /<a href="https:\/\/example.com\/a.png" rel="noopener noreferrer" target="_blank" aria-describedby="[^"]+">x<\/a>/,
    );
  });

  test('リンクの中の画像は、<a> を入れ子にしない', () => {
    const out = html('[![x](https://example.com/a.png)](https://example.com/outer)');
    expect(out.match(/<a /g)).toHaveLength(1);
    expect(out).toContain('href="https://example.com/outer"');
  });

  test('相対リンクと mailto: は文字で出る', () => {
    const out = html('[a](/aoba/w/1?task=2) [b](mailto:a@example.com)');
    expect(out).toContain('<p>a b</p>');
  });

  test.each(['./Markdown.svelte', './MarkdownBlocks.svelte', './MarkdownPlain.svelte'])(
    '%s は HTML を差し込む記法とインラインの style を使っていない',
    (file) => {
      const component = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(component).not.toContain('{@html');
      expect(component).not.toMatch(/\sstyle=/);
      expect(component).not.toContain('<style');
    },
  );
});

describe('MarkdownBlocks の描画', () => {
  test('http と https のリンクは rel と target を持ち、新しいタブで開くことを補足（aria-describedby）で伝える', () => {
    const out = html('[x](http://example.com/)');
    const id =
      /<a href="http:\/\/example.com\/" rel="noopener noreferrer" target="_blank" aria-describedby="([^"]+)">x<\/a>/.exec(
        out,
      )?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`<span id="${id}" hidden="">新しいタブで開きます</span>`);
  });

  test('新しいタブの補足は、リンクの名前にも、チェックリストの箱の名前にも入らない', () => {
    const out = html('- [ ] [x](http://example.com/) を開く');
    const label = /<div id="[^"]+">(.*?)<\/div>/.exec(out)?.[1] ?? '';
    expect(label).toContain('x</a> を開く');
    expect(label).not.toContain('新しいタブ');
  });

  test('自動リンクが描かれ、mailto: の自動リンクは文字', () => {
    expect(html('https://example.com/a')).toContain('<a href="https://example.com/a"');
    expect(html('a@example.com')).not.toContain('<a');
  });

  test('打ち消し線、表、チェックリスト', () => {
    expect(html('~~a~~')).toContain('<del>a</del>');
    const table = html('| a | b |\n| :-- | --: |\n| 1 | 2 |');
    expect(table).toContain('<table>');
    expect(table).toContain('<th scope="col" class="is-left">a</th>');
    expect(table).toContain('<td class="is-right">2</td>');
    const list = html('- [ ] a\n- [x] b');
    expect(list.match(/<input type="checkbox"[^>]*disabled/g)).toHaveLength(2);
    expect(list).toMatch(/<input type="checkbox" checked[^>]*disabled/);
  });

  test('見出しは引数の段から始まり h6 で止まる', () => {
    const source = '# a\n\n## b\n\n### c\n\n#### d\n\n##### e\n\n###### f';
    const tags = (out: string) => [...out.matchAll(/<(h[1-6])[ >]/g)].map((m) => m[1]);
    expect(tags(html(source))).toEqual(['h3', 'h4', 'h5', 'h6', 'h6', 'h6']);
    expect(tags(html(source, 1))).toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
    expect(tags(html(source, 5))).toEqual(['h5', 'h6', 'h6', 'h6', 'h6', 'h6']);
    expect(html('# a')).toContain('class="doc-h1"');
    expect(html('###### a', 4)).toContain('<h6 class="doc-h6">');
  });

  test('不正な headingStart は、数でなければ既定の h3、範囲外は h1 と h6 に丸める', () => {
    const tag = (headingStart: number) => /<(h[1-6])[ >]/.exec(html('# a', headingStart))?.[1];
    expect(tag(Number.NaN)).toBe('h3');
    expect(tag(0)).toBe('h1');
    expect(tag(-5)).toBe('h1');
    expect(tag(-Infinity)).toBe('h1');
    expect(tag(7)).toBe('h6');
    expect(tag(Infinity)).toBe('h6');
    expect(tag(2.7)).toBe('h2');
  });

  test('密なリストは段落を <p> で包まず、空行のあるリストは包む', () => {
    expect(html('- a\n- b')).toContain('<li>a</li><li>b</li>');
    expect(html('- a\n\n- b')).toContain('<li><p>a</p></li>');
  });

  test('項目の中を空行で区切った段落は、連結せず別々の <p> にする', () => {
    expect(html('- b\n\n  c\n- d')).toContain('<li><p>b</p><p>c</p></li>');
    expect(html('- [ ] a\n\n  b')).toContain('<p>a</p><p>b</p>');
  });

  test('チェックリストの箱は項目の中身と結び、一覧として読み上げさせる', () => {
    const out = html('- [ ] a\n- [x] b');
    expect(out).toContain('<ul role="list">');
    const labels = [...out.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
    for (const id of labels) expect(out).toContain(`<div id="${id}">`);
  });

  test('100項目を超えるリストも、頁をまたいで全項目を順に描き、チェックリストの id は重ならない', () => {
    const out = html(`${'- [ ] a\n'.repeat(250)}`);
    expect(out.match(/<li class="is-task">/g)).toHaveLength(250);
    const ids = [...out.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(250);
  });

  test('100行を超える表も、全行を描く', () => {
    const rows = Array.from({ length: 250 }, (_, i) => `| ${i} |`).join('\n');
    const out = html(`| n |\n| - |\n${rows}`);
    expect(out.match(/<tr>/g)).toHaveLength(251);
  });

  test('100節を超える本文も、全部を順に描く', () => {
    const out = html(Array.from({ length: 250 }, (_, i) => `p${i}`).join('\n\n'));
    expect(out.match(/<p>/g)).toHaveLength(250);
    expect(out.indexOf('p0<')).toBeLessThan(out.indexOf('p249<'));
  });

  test('順序付きのチェックリストは ol のまま（番号を残す）', () => {
    const out = html('1. [ ] a\n2. [x] b');
    expect(out).toContain('<ol>');
    expect(out).not.toContain('role="list"');
  });

  test('変換を待つ間は aria-busy', () => {
    const blocks = parseMarkdown('a') ?? [];
    expect(render(MarkdownBlocks, { props: { blocks, busy: true } }).body).toContain('aria-busy="true"');
    expect(render(MarkdownBlocks, { props: { blocks } }).body).not.toContain('aria-busy');
  });
});

describe('MarkdownPlain（変換の前と、時間切れ、失敗）', () => {
  test('本文を書かれたまま文字で出し、HTML は要素にならない', () => {
    const out = withoutComments(
      render(MarkdownPlain, { props: { source: '<script>alert(1)</script>\n# 見出し' } }).body,
    );
    expect(out).toBe('<div class="doc-box is-plain">&lt;script>alert(1)&lt;/script>\n# 見出し</div>');
  });

  test('待つ間は aria-busy を付け、注記は添えない', () => {
    const out = withoutComments(render(MarkdownPlain, { props: { source: 'a', busy: true } }).body);
    expect(out).toBe('<div class="doc-box is-plain" aria-busy="true">a</div>');
  });

  test('時間切れと失敗では、枠の上に整形していない旨を添える', () => {
    const out = withoutComments(render(MarkdownPlain, { props: { source: 'a', noted: true } }).body);
    expect(out).toBe('<p class="props-note">整形せずに表示しています</p><div class="doc-box is-plain">a</div>');
  });
});

describe('Markdown.svelte（Worker が動かない描画）', () => {
  // svelte/server の描画では Worker を立てないので、変換を待つ状態のまま文字で出す
  test('本文を文字のまま出す', () => {
    const out = withoutComments(
      render(Markdown, { props: { source: '<script>alert(1)</script>\n[x](javascript:alert(1))\n# 見出し' } }).body,
    );
    expect(out).toBe(
      '<div class="doc-box is-plain" aria-busy="true">&lt;script>alert(1)&lt;/script>\n[x](javascript:alert(1))\n# 見出し</div>',
    );
  });

  test('10万字の本文でも文字のまま出せる', () => {
    expect(() => render(Markdown, { props: { source: 'あ'.repeat(100_000) } })).not.toThrow();
  });
});

describe('MarkdownBlocks の長さ', () => {
  test('1万段の入れ子を描ける', () => {
    const out = html(`${'>'.repeat(10_000)} x`);
    expect(out.match(/<blockquote>/g)).toHaveLength(32);
  });

  test('32段を超えるリストは、超えた分を文字で描く', () => {
    expect(html(`${'- '.repeat(100)}x`).match(/<ul>/g)).toHaveLength(32);
  });

  test('10万字の本文を描ける', () => {
    expect(() => html('あ'.repeat(100_000))).not.toThrow();
    expect(() => html('*a '.repeat(33_333))).not.toThrow();
    expect(() => html('- [ ] a\n'.repeat(12_000))).not.toThrow();
  }, 30_000);
});
