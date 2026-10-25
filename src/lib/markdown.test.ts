import { describe, expect, test } from 'vitest';
import {
  MAX_NESTING,
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_NODES,
  MAX_URL_LENGTH,
  parseMarkdown,
  safeHref,
  type MarkdownBlock,
  type MarkdownInline,
} from './markdown.ts';

// 上限を超えない本文の変換
const parse = (source: string): MarkdownBlock[] => {
  const blocks = parseMarkdown(source);
  if (blocks === null) throw new Error('変換が上限で止まった');
  return blocks;
};

const firstInlines = (source: string): MarkdownInline[] => {
  const [first] = parse(source);
  if (first?.type !== 'paragraph') throw new Error(`段落でない: ${JSON.stringify(first)}`);
  return first.children;
};

const textOf = (nodes: MarkdownInline[]): string =>
  nodes.map((n) => ('value' in n ? n.value : 'children' in n ? textOf(n.children) : '')).join('');

type ListBlock = Extract<MarkdownBlock, { type: 'list' }>;
type TableBlock = Extract<MarkdownBlock, { type: 'table' }>;

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

  test('ユーザー情報の付いた URL は通さない（行き先を偽れるため）', () => {
    expect(safeHref('https://example.com@evil.example/')).toBeNull();
    expect(safeHref('https://user:pass@example.com/')).toBeNull();
    expect(safeHref('https://example.com/a@b')).toBe('https://example.com/a@b');
  });

  test(`${MAX_URL_LENGTH}字を超える URL は通さない`, () => {
    const prefix = 'https://example.com/';
    expect(safeHref(prefix + 'a'.repeat(MAX_URL_LENGTH - prefix.length))).not.toBeNull();
    expect(safeHref(prefix + 'a'.repeat(MAX_URL_LENGTH - prefix.length + 1))).toBeNull();
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
    '[x](https://example.com@evil.example/)',
  ])('%s は文字になる', (source) => {
    expect(firstInlines(source)).toEqual([{ type: 'text', value: 'x' }]);
  });

  test('中身が空のリンクは URL を文字にする', () => {
    expect(firstInlines('[](https://example.com/a)')).toEqual([{ type: 'text', value: 'https://example.com/a' }]);
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
    const blocks = parse('> [1]: https://example.com/\n\n[x][1]');
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

  test('閉じていない [ の後ろの URL は、自動リンクにならない（mdast の transforms を外した差）', () => {
    expect(firstInlines('[ https://example.com/a').some((n) => n.type === 'link')).toBe(false);
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

  test('リンクの中の画像は、リンクを入れ子にせず文字だけにする', () => {
    expect(firstInlines('[![図](https://example.com/a.png)](https://example.com/outer)')).toEqual([
      { type: 'link', href: 'https://example.com/outer', children: [{ type: 'text', value: '図' }] },
    ]);
    expect(firstInlines('[![](https://example.com/a.png)](https://example.com/outer)')).toEqual([
      {
        type: 'link',
        href: 'https://example.com/outer',
        children: [{ type: 'text', value: 'https://example.com/a.png' }],
      },
    ]);
    expect(firstInlines('[![図][1]](https://example.com/outer)\n\n[1]: https://example.com/a.png')).toEqual([
      { type: 'link', href: 'https://example.com/outer', children: [{ type: 'text', value: '図' }] },
    ]);
  });

  test('リンクにならない外側の中の画像は、ふつうにリンクになる', () => {
    expect(firstInlines('[![図](https://example.com/a.png)](/relative)')).toEqual([
      { type: 'link', href: 'https://example.com/a.png', children: [{ type: 'text', value: '図' }] },
    ]);
  });
});

describe('parseMarkdown の HTML', () => {
  test('ブロックの HTML は、改行を保つ文字になる', () => {
    expect(parse('<script>alert(1)</script>')).toEqual([{ type: 'literal', value: '<script>alert(1)</script>' }]);
  });

  test('行の中の HTML は文字になる', () => {
    const inlines = firstInlines('a <img src=x onerror=alert(1)> b');
    expect(textOf(inlines)).toBe('a <img src=x onerror=alert(1)> b');
    expect(inlines.some((n) => n.type === 'literal')).toBe(true);
  });
});

describe('parseMarkdown の書式', () => {
  test('見出し、引用、リスト、コード、区切り線', () => {
    const blocks = parse('# h\n\n> q\n\n1. a\n2. b\n\n- c\n\n```js\nx\n```\n\n---');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'quote', 'list', 'list', 'code', 'rule']);
    expect(blocks[2]).toMatchObject({ type: 'list', ordered: true, start: 1 });
    expect(blocks[3]).toMatchObject({ type: 'list', ordered: false, start: null });
    expect(blocks[4]).toEqual({ type: 'code', value: 'x' });
  });

  test('項目の間に空行の無いリストは tight', () => {
    expect((parse('- a\n- b')[0] as ListBlock).tight).toBe(true);
    expect((parse('- a\n\n- b')[0] as ListBlock).tight).toBe(false);
  });

  test('項目の中に空行で区切った段落があるリストは tight でない（段落を連結しない）', () => {
    expect((parse('- b\n\n  c\n- d')[0] as ListBlock).tight).toBe(false);
    expect((parse('- [ ] a\n\n  b')[0] as ListBlock).tight).toBe(false);
    expect((parse('1. a\n\n   b\n2. c')[0] as ListBlock).tight).toBe(false);
  });

  test('打ち消し線は ~~ だけで、~ 1つは文字', () => {
    expect(firstInlines('~~a~~')).toEqual([{ type: 'delete', children: [{ type: 'text', value: 'a' }] }]);
    expect(firstInlines('1~2')).toEqual([{ type: 'text', value: '1~2' }]);
  });

  test('チェックリストの項目は checked を持つ', () => {
    const [list] = parse('- [ ] a\n- [x] b\n- c') as ListBlock[];
    expect(list.items.map((i) => i.checked)).toEqual([false, true, null]);
  });

  test('表は見出し、行、寄せを持つ', () => {
    const [table] = parse('| a | b |\n| :-- | --: |\n| 1 | 2 |') as TableBlock[];
    expect(table.align).toEqual(['left', 'right']);
    expect(table.head.map(textOf)).toEqual(['a', 'b']);
    expect(table.rows.map((row) => row.map(textOf))).toEqual([['1', '2']]);
  });

  test('表の本文の行は、見出しの列数に切り詰め、足りない分は空のセルで埋める', () => {
    const [table] = parse('| a | b |\n| - | - |\n| 1 | 2 | 3 | 4 |\n| 5 |') as TableBlock[];
    expect(table.rows.map((row) => row.map(textOf))).toEqual([
      ['1', '2'],
      ['5', ''],
    ]);
    expect(table.align).toHaveLength(2);
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

  test('引用は32段まで描き、超えた分は書かれたままの文字にする', () => {
    const blocks = parse(`${'>'.repeat(MAX_NESTING + 3)} deep`);
    expect(quoteDepth(blocks)).toBe(MAX_NESTING);
    let node: MarkdownBlock | undefined = blocks[0];
    while (node?.type === 'quote') node = node.children[0];
    expect(node).toMatchObject({ type: 'literal' });
    expect(JSON.stringify(node)).toContain('deep');
  });

  test('32段ちょうどは文字にならない', () => {
    expect(quoteDepth(parse(`${'>'.repeat(MAX_NESTING)} deep`))).toBe(MAX_NESTING);
  });

  test('強調の入れ子も上限で止まる', () => {
    const source = `${'*a '.repeat(100)}b${' a*'.repeat(100)}`;
    const depthOf = (nodes: MarkdownInline[]): number =>
      Math.max(0, ...nodes.map((n) => ('children' in n ? 1 + depthOf(n.children) : 0)));
    expect(depthOf(firstInlines(source))).toBeLessThanOrEqual(MAX_NESTING);
  });

  test('1万段の引用で落ちない', () => {
    const blocks = parse(`${'>'.repeat(10_000)} x`);
    expect(quoteDepth(blocks)).toBe(MAX_NESTING);
  });

  test('深いリストは32段で止まる', () => {
    const blocks = parse(`${'- '.repeat(100)}x`);
    let depth = 0;
    for (let node = blocks[0]; node?.type === 'list'; node = node.items[0]?.children[0]) depth++;
    expect(depth).toBe(MAX_NESTING);
  });

  test('10万字の本文で落ちない', () => {
    expect(parseMarkdown('あ'.repeat(100_000))).not.toBeNull();
    expect(parseMarkdown('*a '.repeat(33_333))).not.toBeNull();
    expect(parseMarkdown('[a](https://example.com) '.repeat(4_000))).not.toBeNull();
    expect(parseMarkdown('|a'.repeat(50_000))).not.toBeNull();
    expect(parseMarkdown('- [ ] a\n'.repeat(12_000))).not.toBeNull();
    expect(parseMarkdown('a\\\n'.repeat(20_000))).not.toBeNull();
  }, 30_000);
});

describe('出力の上限', () => {
  test('長い URL の定義に短い参照を並べても、出力は膨らまない（URL が長すぎて、リンクにならない）', () => {
    const url = `https://a.example/${'a'.repeat(MAX_URL_LENGTH)}`;
    const blocks = parse(`[x]: ${url}\n\n${'[x] '.repeat(20_000)}`);
    expect(JSON.stringify(blocks)).not.toContain(url);
    expect(JSON.stringify(blocks)).not.toContain('"link"');
  }, 30_000);

  test('上限に収まる長さの URL を何千も複製する本文は、変換をやめる（null）', () => {
    const url = `https://a.example/${'a'.repeat(1500)}`;
    expect(parseMarkdown(`[x]: ${url}\n\n${'[x] '.repeat(20_000)}`)).toBeNull();
    expect(parseMarkdown(`[x]: ${url}\n\n${'![][x]'.repeat(15_000)}`)).toBeNull();
  }, 30_000);

  test('見出し、リスト、表、リンクが混ざった正当な10万字の本文は、上限に掛からない', () => {
    const unit =
      '## 見出し\n\n本文の段落。*強調*と**太字**と`code`と[リンク](https://example.com/a)を含む。\n\n- 項目1\n- 項目2 [x](https://example.com/b)\n- [ ] 作業\n\n| a | b | c |\n| - | - | - |\n| 1 | 2 | [l](https://e.example) |\n\n> 引用\n\n';
    const source = unit.repeat(Math.floor(100_000 / unit.length));
    expect(source.length).toBeGreaterThan(90_000);
    expect(parseMarkdown(source)).not.toBeNull();
  }, 30_000);

  test('チェックリスト中心の10万字の本文（節が約3.7万）は、上限に掛からない', () => {
    const source = '- [ ] a\n'.repeat(12_000);
    expect(source.length).toBeGreaterThan(90_000);
    expect(parseMarkdown(source)).not.toBeNull();
  }, 30_000);

  test('出力の文字数の上限を超える本文は null', () => {
    expect(parseMarkdown('あ'.repeat(MAX_OUTPUT_CHARS + 1))).toBeNull();
    expect(parseMarkdown('あ'.repeat(MAX_OUTPUT_CHARS))).not.toBeNull();
  }, 30_000);

  test('出力の節の数の上限を超える本文は null', () => {
    // `a` と空行の3字が、段落と文字の2節
    const paragraphs = (count: number) => 'a\n\n'.repeat(count);
    expect(parseMarkdown(paragraphs(MAX_OUTPUT_NODES / 2 + 1))).toBeNull();
    expect(parseMarkdown(paragraphs(1000))).not.toBeNull();
  }, 30_000);
});
