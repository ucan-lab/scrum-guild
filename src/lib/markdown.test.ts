import { describe, expect, test } from 'vitest';
import { MAX_NESTING, parseMarkdown, safeHref, type MarkdownBlock, type MarkdownInline } from './markdown.ts';

const firstInlines = (source: string): MarkdownInline[] => {
  const [first] = parseMarkdown(source);
  if (first?.type !== 'paragraph') throw new Error(`段落でない: ${JSON.stringify(first)}`);
  return first.children;
};

const textOf = (nodes: MarkdownInline[]): string =>
  nodes.map((n) => ('value' in n ? n.value : 'children' in n ? textOf(n.children) : '')).join('');

describe('safeHref', () => {
  test('絶対の http と https だけを通し、解析した形で返す', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHref('HTTP://Example.com')).toBe('http://example.com/');
    expect(safeHref('  https://example.com  ')).toBe('https://example.com/');
  });

  test.each([
    '/aoba/w/1?task=2',
    'a/b',
    '//example.com',
    'http:example.com',
    'mailto:a@example.com',
    'javascript:alert(1)',
    'java\tscript:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ftp://example.com',
    'https://',
    '',
  ])('%j は通さない', (url) => {
    expect(safeHref(url)).toBeNull();
  });
});

describe('parseMarkdown のリンク', () => {
  test('http と https のリンクだけがリンクになる', () => {
    expect(firstInlines('[x](https://example.com/a)')).toEqual([
      { type: 'link', href: 'https://example.com/a', children: [{ type: 'text', value: 'x' }] },
    ]);
  });

  test.each([
    '[x](javascript:alert(1))',
    '[x](data:text/html;base64,AAAA)',
    '[x](/aoba/w/1?task=2)',
    '[x](mailto:a@example.com)',
  ])('%s は文字になる', (source) => {
    expect(firstInlines(source)).toEqual([{ type: 'text', value: 'x' }]);
  });

  test('参照形式のリンクも定義を引いて同じ規則にかける', () => {
    expect(firstInlines('[x][1]\n\n[1]: https://example.com/')).toEqual([
      { type: 'link', href: 'https://example.com/', children: [{ type: 'text', value: 'x' }] },
    ]);
    expect(firstInlines('[x][1]\n\n[1]: javascript:alert(1)')).toEqual([{ type: 'text', value: 'x' }]);
    expect(firstInlines('[x][1]\n\n[1]: /relative')).toEqual([{ type: 'text', value: 'x' }]);
  });

  test('同じ名前の定義は先に書いたものを採る', () => {
    const inlines = firstInlines('[x][a]\n\n[a]: https://first.example/\n[a]: https://second.example/');
    expect(inlines[0]).toMatchObject({ type: 'link', href: 'https://first.example/' });
  });

  test('定義の無い参照は書かれたままの文字になる', () => {
    expect(textOf(firstInlines('[x][nope]'))).toBe('[x][nope]');
  });

  test('引用の中の定義も引ける', () => {
    const blocks = parseMarkdown('> [1]: https://example.com/\n\n[x][1]');
    expect(blocks.at(-1)).toMatchObject({ children: [{ type: 'link', href: 'https://example.com/' }] });
  });

  test('自動リンクにも同じ規則が効く', () => {
    expect(firstInlines('https://example.com/a')).toEqual([
      { type: 'link', href: 'https://example.com/a', children: [{ type: 'text', value: 'https://example.com/a' }] },
    ]);
    expect(firstInlines('www.example.com')[0]).toMatchObject({ type: 'link', href: 'http://www.example.com/' });
    expect(firstInlines('a@example.com')).toEqual([{ type: 'text', value: 'a@example.com' }]);
    expect(firstInlines('<mailto:a@example.com>')).toEqual([{ type: 'text', value: 'mailto:a@example.com' }]);
    expect(firstInlines('<https://example.com>')[0]).toMatchObject({ type: 'link', href: 'https://example.com/' });
  });
});

describe('parseMarkdown の画像', () => {
  test('http と https の画像は代わりの文字のリンクになる', () => {
    expect(firstInlines('![図](https://example.com/a.png)')).toEqual([
      { type: 'link', href: 'https://example.com/a.png', children: [{ type: 'text', value: '図' }] },
    ]);
  });

  test('代わりの文字が無ければ URL が文字になる', () => {
    expect(firstInlines('![](https://example.com/a.png)')).toEqual([
      {
        type: 'link',
        href: 'https://example.com/a.png',
        children: [{ type: 'text', value: 'https://example.com/a.png' }],
      },
    ]);
  });

  test('それ以外の画像は代わりの文字だけになる', () => {
    expect(firstInlines('![図](data:image/png;base64,AAAA)')).toEqual([{ type: 'text', value: '図' }]);
    expect(firstInlines('![図](/files/1)')).toEqual([{ type: 'text', value: '図' }]);
    expect(firstInlines('![](javascript:alert(1))')).toEqual([]);
  });

  test('参照形式の画像も定義を引く', () => {
    expect(firstInlines('![図][1]\n\n[1]: https://example.com/a.png')[0]).toMatchObject({ type: 'link' });
    expect(firstInlines('![図][1]\n\n[1]: data:image/png;base64,AAAA')).toEqual([{ type: 'text', value: '図' }]);
  });
});

describe('parseMarkdown の HTML', () => {
  test('ブロックの HTML は文字になる', () => {
    expect(parseMarkdown('<script>alert(1)</script>')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: '<script>alert(1)</script>' }] },
    ]);
  });

  test('行の中の HTML は文字になる', () => {
    expect(textOf(firstInlines('a <img src=x onerror=alert(1)> b'))).toBe('a <img src=x onerror=alert(1)> b');
  });
});

describe('parseMarkdown の書式', () => {
  test('見出し、引用、リスト、コード、区切り線', () => {
    const blocks = parseMarkdown('# h\n\n> q\n\n1. a\n2. b\n\n- c\n\n```js\nx\n```\n\n---');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'quote', 'list', 'list', 'code', 'rule']);
    expect(blocks[2]).toMatchObject({ type: 'list', ordered: true, start: 1 });
    expect(blocks[3]).toMatchObject({ type: 'list', ordered: false, start: null });
    expect(blocks[4]).toEqual({ type: 'code', value: 'x' });
  });

  test('打ち消し線は ~~ だけで、~ 1つは文字', () => {
    expect(firstInlines('~~a~~')).toEqual([{ type: 'delete', children: [{ type: 'text', value: 'a' }] }]);
    expect(firstInlines('1~2')).toEqual([{ type: 'text', value: '1~2' }]);
  });

  test('チェックリストの項目は checked を持つ', () => {
    const [list] = parseMarkdown('- [ ] a\n- [x] b\n- c') as Extract<MarkdownBlock, { type: 'list' }>[];
    expect(list.items.map((i) => i.checked)).toEqual([false, true, null]);
  });

  test('表は見出し、行、寄せを持つ', () => {
    const [table] = parseMarkdown('| a | b |\n| :-- | --: |\n| 1 | 2 |') as Extract<MarkdownBlock, { type: 'table' }>[];
    expect(table.align).toEqual(['left', 'right']);
    expect(table.head.map(textOf)).toEqual(['a', 'b']);
    expect(table.rows.map((row) => row.map(textOf))).toEqual([['1', '2']]);
  });

  test('脚注は入れない', () => {
    expect(textOf(firstInlines('a[^1]'))).toBe('a[^1]');
  });
});

describe('入れ子の上限', () => {
  const quoteDepth = (blocks: MarkdownBlock[]): number => {
    let depth = 0;
    for (let node = blocks[0]; node?.type === 'quote'; node = node.children[0]) depth++;
    return depth;
  };

  test('引用は32段まで描き、超えた分は文字にする', () => {
    const blocks = parseMarkdown(`${'>'.repeat(MAX_NESTING + 3)} deep`);
    expect(quoteDepth(blocks)).toBe(MAX_NESTING);
    let node: MarkdownBlock | undefined = blocks[0];
    while (node?.type === 'quote') node = node.children[0];
    expect(node).toMatchObject({ type: 'paragraph', children: [{ type: 'text' }] });
    expect(JSON.stringify(node)).toContain('deep');
  });

  test('32段ちょうどは文字にならない', () => {
    expect(quoteDepth(parseMarkdown(`${'>'.repeat(MAX_NESTING)} deep`))).toBe(MAX_NESTING);
  });

  test('強調の入れ子も上限で止まる', () => {
    const source = `${'*a '.repeat(100)}b${' a*'.repeat(100)}`;
    const depthOf = (nodes: MarkdownInline[]): number =>
      Math.max(0, ...nodes.map((n) => ('children' in n ? 1 + depthOf(n.children) : 0)));
    expect(depthOf(firstInlines(source))).toBeLessThanOrEqual(MAX_NESTING);
  });

  test('1万段の引用で落ちない', () => {
    const blocks = parseMarkdown(`${'>'.repeat(10_000)} x`);
    expect(quoteDepth(blocks)).toBe(MAX_NESTING);
  });

  test('深いリストは32段で止まる', () => {
    const blocks = parseMarkdown(`${'- '.repeat(100)}x`);
    let depth = 0;
    for (let node = blocks[0]; node?.type === 'list'; node = node.items[0]?.children[0]) depth++;
    expect(depth).toBe(MAX_NESTING);
  });

  test('10万字の本文で落ちない', () => {
    expect(() => parseMarkdown('あ'.repeat(100_000))).not.toThrow();
    expect(() => parseMarkdown('*a '.repeat(33_333))).not.toThrow();
    expect(() => parseMarkdown('[a](https://example.com) '.repeat(4_000))).not.toThrow();
    expect(() => parseMarkdown('|a'.repeat(50_000))).not.toThrow();
  });
});
