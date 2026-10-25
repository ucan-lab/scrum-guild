import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, test } from 'vitest';
import { parseMarkdown } from '../markdown.ts';
import Markdown from './Markdown.svelte';
import MarkdownBlocks from './MarkdownBlocks.svelte';

// svelte/server の出力には、ハイドレーション用のコメントが入る。要素と属性だけを見るため外す
const withoutComments = (body: string) => body.replace(/<!--.*?-->/g, '');
// 変換済みの節を描く部分。変換は Worker で行うので、ここでは parseMarkdown の結果を直に渡す
const html = (source: string, headingStart?: number) =>
  withoutComments(render(MarkdownBlocks, { props: { blocks: parseMarkdown(source), headingStart } }).body);

// 本文が文字なら、開始タグは枠の div と段落の p だけで、属性は枠の class だけになる
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
  ])('%s は要素や属性として出ない', (source) => {
    const out = html(source);
    expect(tagsOf(out)).toEqual(['div', 'p']);
    expect(attributesOf(out)).toEqual(['class="doc-box"']);
  });

  test('生の HTML は文字として出る', () => {
    expect(html('<script>alert(1)</script>')).toContain('&lt;script>alert(1)&lt;/script>');
  });

  test('外部の画像は img でなくリンクとして出る', () => {
    const out = html('![x](https://example.com/a.png)');
    expect(out).not.toContain('<img');
    expect(out).toContain('<a href="https://example.com/a.png" rel="noopener noreferrer" target="_blank">x</a>');
  });

  test('相対リンクと mailto: は文字で出る', () => {
    const out = html('[a](/aoba/w/1?task=2) [b](mailto:a@example.com)');
    expect(out).toContain('<p>a b</p>');
  });

  test.each(['./Markdown.svelte', './MarkdownBlocks.svelte'])(
    '%s は HTML を差し込む記法とインラインの style を使っていない',
    (file) => {
      const component = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(component).not.toContain('{@html');
      expect(component).not.toMatch(/\sstyle=/);
      expect(component).not.toContain('<style');
    },
  );
});

describe('Markdown.svelte（変換の前と、Worker が使えないとき）', () => {
  // svelte/server の描画では Worker を立てないので、本文を文字のまま出す
  test('本文を文字のまま出し、HTML は要素にならない', () => {
    const out = withoutComments(
      render(Markdown, { props: { source: '<script>alert(1)</script>\n[x](javascript:alert(1))\n# 見出し' } }).body,
    );
    expect(out).toBe(
      '<div class="doc-box is-plain">&lt;script>alert(1)&lt;/script>\n[x](javascript:alert(1))\n# 見出し</div>',
    );
  });

  test('10万字の本文でも文字のまま出せる', () => {
    expect(() => render(Markdown, { props: { source: 'あ'.repeat(100_000) } })).not.toThrow();
  });
});

describe('Markdown.svelte の描画', () => {
  test('http と https のリンクは rel と target を持つ', () => {
    expect(html('[x](http://example.com/)')).toContain(
      '<a href="http://example.com/" rel="noopener noreferrer" target="_blank">x</a>',
    );
  });

  test('自動リンクが描かれ、mailto: の自動リンクは文字', () => {
    expect(html('https://example.com/a')).toContain('<a href="https://example.com/a"');
    expect(html('a@example.com')).not.toContain('<a');
  });

  test('打ち消し線、表、チェックリスト', () => {
    expect(html('~~a~~')).toContain('<del>a</del>');
    const table = html('| a | b |\n| :-- | --: |\n| 1 | 2 |');
    expect(table).toContain('<table>');
    expect(table).toContain('<th class="is-left">a</th>');
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
});

describe('Markdown.svelte の長さ', () => {
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
  });
});
