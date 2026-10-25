// Markdown の本文を、画面に描いてよい節の木に直す。MarkdownBlocks.svelte はこの木を描くだけで、
// リンクと画像の規則（http と https の絶対 URL だけ）、生の HTML を文字にすること、入れ子と出力の上限はここだけが持つ。
// HTML の文字列を作らないので、無害化器は要らない。
import type { Nodes, PhrasingContent, Root, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item';
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';

// 本文は最大10万字。`>` を並べるだけで再帰の描画のスタックがあふれるので、これより深い入れ子は文字で出す
export const MAX_NESTING = 32;

// リンクにする URL の長さ。ブラウザとサーバーが実際に受ける長さの目安で、これを超える URL は書き手の意図したリンクではない。
// 長い URL の定義 1 つに短い参照を並べると、参照ごとに href が複製されて出力が膨らむので、そもそも長い URL は通さない
export const MAX_URL_LENGTH = 2048;

// 出力の総量の上限。超える本文は変換をやめ、文字のまま出す。
// 文字は、本文の最大（10万字）の4倍。普通の本文は1倍前後で、href と入れ子の上限で切り出した原文の複製を含めても余る。
// 節は、描画の時間で決めた。節を DOM にする時間は節の数に比例し、手元（Chromium、Mac）で測ると、
// 見出し、段落、リスト、表、リンクが混ざった93k字の本文は節が約2.2万で約255ms、チェックリスト中心の96k字は節が約3.7万で約1.07秒、
// 節が20万の表の本文は約1.7秒止まった（CPU を4倍に絞るとさらに約4倍）。
// 段階の描画（markdown-render.ts）で1フレームの停止は抑えるが、節の総量が大きいと描き終わるまでが長いので、
// 正当な最大の本文（上の約3.7万）が通る5万を上限にする
export const MAX_OUTPUT_CHARS = 400_000;
export const MAX_OUTPUT_NODES = 50_000;

export type MarkdownInline =
  | { type: 'text'; value: string }
  // 書かれたままを、改行を保って出す文字（生の HTML、入れ子の上限で打ち切った分）
  | { type: 'literal'; value: string }
  | { type: 'code'; value: string }
  | { type: 'break' }
  | { type: 'emphasis' | 'strong' | 'delete'; children: MarkdownInline[] }
  | { type: 'link'; href: string; children: MarkdownInline[] };

export type MarkdownAlign = 'left' | 'center' | 'right' | null;

export type MarkdownListItem = {
  // チェックリストの項目は真偽、ふつうの項目は null
  checked: boolean | null;
  children: MarkdownBlock[];
};

export type MarkdownBlock =
  | { type: 'paragraph'; children: MarkdownInline[] }
  | { type: 'literal'; value: string }
  | { type: 'heading'; depth: 1 | 2 | 3 | 4 | 5 | 6; children: MarkdownInline[] }
  | { type: 'quote'; children: MarkdownBlock[] }
  // tight は、項目の間にも項目の中にも空行の無い密なリスト。項目の段落を `<p>` で包まない
  | { type: 'list'; ordered: boolean; start: number | null; tight: boolean; items: MarkdownListItem[] }
  | { type: 'code'; value: string }
  | { type: 'rule' }
  // head の列数に、本文の行の列数をそろえる
  | { type: 'table'; align: MarkdownAlign[]; head: MarkdownInline[][]; rows: MarkdownInline[][][] };

type Context = {
  source: string;
  definitions: Map<string, string>;
  nodes: number;
  chars: number;
};

class OutputLimitError extends Error {}

// 出力を作る前に数える。上限を超えたら変換を止める
function charge(ctx: Context, nodes: number, chars = 0) {
  ctx.nodes += nodes;
  ctx.chars += chars;
  if (ctx.nodes > MAX_OUTPUT_NODES || ctx.chars > MAX_OUTPUT_CHARS) throw new OutputLimitError();
}

function made<T>(ctx: Context, node: T, chars = 0): T {
  charge(ctx, 1, chars);
  return node;
}

// 相対（`/aoba/w/1?task=2`）、`mailto:`、`javascript:`、`data:` は null。`http:foo` のように、
// 解釈する側が相対として扱いうる綴りも通さないため、`//` までを先に見る
const ABSOLUTE_HTTP_URL = /^https?:\/\//i;

export function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length > MAX_URL_LENGTH || !ABSOLUTE_HTTP_URL.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // `https://信頼できる名前@悪いホスト/` のように、リンクの見た目で行き先を偽れる
    if (parsed.username || parsed.password) return null;
    return parsed.href.length <= MAX_URL_LENGTH ? parsed.href : null;
  } catch {
    return null;
  }
}

// 自動リンクの mdast の拡張が持つ `transforms` は、構文木を再帰で歩く（unist-util-visit-parents）ので、
// 6000段ほどの引用でスタックがあふれる。外しても、リンクは micromark 側の字句が作る。
// 違いは、閉じていない `[` の後ろの URL（`[ https://example.com`、`[www.example.com`）がリンクにならないこと
const autolinkFromMarkdown = { ...gfmAutolinkLiteralFromMarkdown(), transforms: [] };

// null は、出力の上限を超えたので変換をやめたこと。呼び出し側は本文を文字のまま出す
export function parseMarkdown(source: string): MarkdownBlock[] | null {
  const tree: Root = fromMarkdown(source, {
    // 打ち消し線は `~~` だけにする。`1~2` のような範囲の書き方を巻き込まないため
    extensions: [gfmAutolinkLiteral(), gfmStrikethrough({ singleTilde: false }), gfmTable(), gfmTaskListItem()],
    mdastExtensions: [
      autolinkFromMarkdown,
      gfmStrikethroughFromMarkdown(),
      gfmTableFromMarkdown(),
      gfmTaskListItemFromMarkdown(),
    ],
  });
  const ctx: Context = { source, definitions: collectDefinitions(tree), nodes: 0, chars: 0 };
  try {
    return blocks(tree.children, 0, ctx);
  } catch (error) {
    if (error instanceof OutputLimitError) return null;
    throw error;
  }
}

// 構文木は1万段にもなりうるので、再帰せずに集める。同じ名前の定義は先に書いたものを採る
function collectDefinitions(root: Nodes): Map<string, string> {
  const found = new Map<string, { url: string; offset: number }>();
  const stack: Nodes[] = [root];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.type === 'definition') {
      const offset = node.position?.start.offset ?? 0;
      const known = found.get(node.identifier);
      if (!known || offset < known.offset) found.set(node.identifier, { url: node.url, offset });
    }
    if ('children' in node) stack.push(...(node.children as Nodes[]));
  }
  return new Map([...found].map(([identifier, { url }]) => [identifier, url]));
}

// 上限を超えた節は、書かれたままの Markdown を文字にする
function raw(node: Nodes, ctx: Context): string {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? '' : ctx.source.slice(start, end);
}

function literalBlock(ctx: Context, value: string): MarkdownBlock[] {
  return value ? [made(ctx, { type: 'literal', value }, value.length)] : [];
}

function literalInline(ctx: Context, value: string): MarkdownInline[] {
  return value ? [made(ctx, { type: 'literal', value }, value.length)] : [];
}

function textOf(ctx: Context, value: string): MarkdownInline[] {
  return value ? [made(ctx, { type: 'text', value }, value.length)] : [];
}

// depth は、いま入っている入れ子の段数。引用、リスト、表、強調、リンクが1段ずつ数える
function blocks(nodes: RootContent[], depth: number, ctx: Context): MarkdownBlock[] {
  return nodes.flatMap((node) => block(node, depth, ctx));
}

function block(node: RootContent, depth: number, ctx: Context): MarkdownBlock[] {
  switch (node.type) {
    case 'paragraph':
      return [made(ctx, { type: 'paragraph', children: inlines(node.children, depth, ctx, false) })];
    case 'heading':
      return [made(ctx, { type: 'heading', depth: node.depth, children: inlines(node.children, depth, ctx, false) })];
    case 'blockquote':
      if (depth >= MAX_NESTING) return literalBlock(ctx, raw(node, ctx));
      return [made(ctx, { type: 'quote', children: blocks(node.children, depth + 1, ctx) })];
    case 'list':
      if (depth >= MAX_NESTING) return literalBlock(ctx, raw(node, ctx));
      return [
        made(ctx, {
          type: 'list',
          ordered: node.ordered ?? false,
          start: node.ordered ? (node.start ?? 1) : null,
          // 項目の間だけでなく、項目の中の段落の間にも空行が無いリスト（空行で区切った段落を、`<p>` なしで連結しない）
          tight: node.spread !== true && node.children.every((item) => item.spread !== true),
          items: node.children.map((item) =>
            made(ctx, { checked: item.checked ?? null, children: blocks(item.children, depth + 1, ctx) }),
          ),
        }),
      ];
    case 'code':
      return [made(ctx, { type: 'code', value: node.value }, node.value.length)];
    case 'thematicBreak':
      return [made(ctx, { type: 'rule' })];
    case 'table': {
      if (depth >= MAX_NESTING) return literalBlock(ctx, raw(node, ctx));
      const [headRow, ...bodyRows] = node.children;
      const columns = headRow?.children.length ?? 0;
      // 本文の行は見出しの列数に切り詰め、足りない分は空のセルで埋める
      const cells = (row: typeof headRow) =>
        Array.from({ length: columns }, (_, column) => {
          charge(ctx, 1);
          return inlines(row?.children[column]?.children ?? [], depth + 1, ctx, false);
        });
      return [
        made(ctx, {
          type: 'table',
          align: Array.from({ length: columns }, (_, column) => node.align?.[column] ?? null),
          head: cells(headRow),
          rows: bodyRows.map(cells),
        }),
      ];
    }
    case 'definition':
      return [];
    default:
      // 生の HTML（`html`）と、ここで扱わない節。書かれたままを文字で出す
      return literalBlock(ctx, 'value' in node && typeof node.value === 'string' ? node.value : raw(node, ctx));
  }
}

// inLink は、リンクの中の本文。`<a>` の中に `<a>` は入れられないので、リンクの中の画像は文字だけにする
function inlines(nodes: PhrasingContent[], depth: number, ctx: Context, inLink: boolean): MarkdownInline[] {
  return nodes.flatMap((node) => inline(node, depth, ctx, inLink));
}

// 画像と参照形式のリンクの URL は定義から引く。定義の無い参照は null
function resolve(identifier: string, ctx: Context): string | null {
  return ctx.definitions.get(identifier) ?? null;
}

// リンクにできない URL のリンクは、リンクの中の文字だけを出す。中身の無いリンクは、見えず読み上げもできないので URL を文字にする
function link(
  url: string | null,
  children: PhrasingContent[],
  depth: number,
  ctx: Context,
  inLink: boolean,
): MarkdownInline[] {
  const href = url === null || inLink ? null : safeHref(url);
  const inner = inlines(children, depth + 1, ctx, inLink || href !== null);
  if (href === null) return inner;
  if (inner.length === 0) return textOf(ctx, href);
  return [made(ctx, { type: 'link', href, children: inner }, href.length)];
}

// 外部の画像は読み込まない（CSP の img-src も許さない）。http と https の画像は、代わりの文字（無ければ URL）のリンクにする。
// リンクの中の画像は、リンクを入れ子にせず文字だけにする
function image(url: string | null, alt: string | null | undefined, ctx: Context, inLink: boolean): MarkdownInline[] {
  const label = alt ?? '';
  const href = url === null ? null : safeHref(url);
  if (href === null) return textOf(ctx, label);
  if (inLink) return textOf(ctx, label || href);
  return [made(ctx, { type: 'link', href, children: textOf(ctx, label || href) }, href.length)];
}

function inline(node: PhrasingContent, depth: number, ctx: Context, inLink: boolean): MarkdownInline[] {
  switch (node.type) {
    case 'text':
      return textOf(ctx, node.value);
    case 'inlineCode':
      return [made(ctx, { type: 'code', value: node.value }, node.value.length)];
    case 'break':
      return [made(ctx, { type: 'break' })];
    case 'emphasis':
    case 'strong':
    case 'delete':
      if (depth >= MAX_NESTING) return literalInline(ctx, raw(node, ctx));
      return [made(ctx, { type: node.type, children: inlines(node.children, depth + 1, ctx, inLink) })];
    case 'link':
      if (depth >= MAX_NESTING) return literalInline(ctx, raw(node, ctx));
      return link(node.url, node.children, depth, ctx, inLink);
    case 'linkReference': {
      if (depth >= MAX_NESTING) return literalInline(ctx, raw(node, ctx));
      const url = resolve(node.identifier, ctx);
      // 定義の無い参照は、書かれたままを文字にする
      return url === null ? literalInline(ctx, raw(node, ctx)) : link(url, node.children, depth, ctx, inLink);
    }
    case 'image':
      return image(node.url, node.alt, ctx, inLink);
    case 'imageReference':
      return image(resolve(node.identifier, ctx), node.alt, ctx, inLink);
    default:
      // 生の HTML（`html`）と、ここで扱わない節。書かれたままを文字で出す
      return literalInline(ctx, 'value' in node && typeof node.value === 'string' ? node.value : raw(node, ctx));
  }
}
