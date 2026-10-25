// Markdown の本文を、画面に描いてよい節の木に直す。Markdown.svelte はこの木を描くだけで、
// リンクと画像の規則（http と https の絶対 URL だけ）、生の HTML を文字にすること、入れ子の上限はここだけが持つ。
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

export type MarkdownInline =
  | { type: 'text'; value: string }
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
  | { type: 'heading'; depth: 1 | 2 | 3 | 4 | 5 | 6; children: MarkdownInline[] }
  | { type: 'quote'; children: MarkdownBlock[] }
  | { type: 'list'; ordered: boolean; start: number | null; items: MarkdownListItem[] }
  | { type: 'code'; value: string }
  | { type: 'rule' }
  | { type: 'table'; align: MarkdownAlign[]; head: MarkdownInline[][]; rows: MarkdownInline[][][] };

type Context = {
  source: string;
  definitions: Map<string, string>;
};

// 相対（`/aoba/w/1?task=2`）、`mailto:`、`javascript:`、`data:` は null。`http:foo` のように、
// 解釈する側が相対として扱いうる綴りも通さないため、`//` までを先に見る
const ABSOLUTE_HTTP_URL = /^https?:\/\//i;

export function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (!ABSOLUTE_HTTP_URL.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

// 自動リンクの mdast の拡張が持つ `transforms` は、構文木を再帰で歩く（unist-util-visit-parents）ので、
// 6000段ほどの引用でスタックがあふれる。リンクは micromark 側の字句が作るので、外しても結果は変わらない
const autolinkFromMarkdown = { ...gfmAutolinkLiteralFromMarkdown(), transforms: [] };

export function parseMarkdown(source: string): MarkdownBlock[] {
  let tree: Root;
  try {
    tree = fromMarkdown(source, {
      // 打ち消し線は `~~` だけにする。`1~2` のような範囲の書き方を巻き込まないため
      extensions: [gfmAutolinkLiteral(), gfmStrikethrough({ singleTilde: false }), gfmTable(), gfmTaskListItem()],
      mdastExtensions: [
        autolinkFromMarkdown,
        gfmStrikethroughFromMarkdown(),
        gfmTableFromMarkdown(),
        gfmTaskListItemFromMarkdown(),
      ],
    });
  } catch {
    // 構文木を作れなかった本文は、画面を壊さず書かれたままの文字で出す
    return textBlock(source);
  }
  return blocks(tree.children, 0, { source, definitions: collectDefinitions(tree) });
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

function textBlock(value: string): MarkdownBlock[] {
  return value ? [{ type: 'paragraph', children: [{ type: 'text', value }] }] : [];
}

// depth は、いま入っている入れ子の段数。引用、リスト、表、強調、リンクが1段ずつ数える
function blocks(nodes: RootContent[], depth: number, ctx: Context): MarkdownBlock[] {
  return nodes.flatMap((node) => block(node, depth, ctx));
}

function block(node: RootContent, depth: number, ctx: Context): MarkdownBlock[] {
  switch (node.type) {
    case 'paragraph':
      return [{ type: 'paragraph', children: inlines(node.children, depth, ctx) }];
    case 'heading':
      return [{ type: 'heading', depth: node.depth, children: inlines(node.children, depth, ctx) }];
    case 'blockquote':
      if (depth >= MAX_NESTING) return textBlock(raw(node, ctx));
      return [{ type: 'quote', children: blocks(node.children, depth + 1, ctx) }];
    case 'list':
      if (depth >= MAX_NESTING) return textBlock(raw(node, ctx));
      return [
        {
          type: 'list',
          ordered: node.ordered ?? false,
          start: node.ordered ? (node.start ?? 1) : null,
          items: node.children.map((item) => ({
            checked: item.checked ?? null,
            children: blocks(item.children, depth + 1, ctx),
          })),
        },
      ];
    case 'code':
      return [{ type: 'code', value: node.value }];
    case 'thematicBreak':
      return [{ type: 'rule' }];
    case 'table': {
      if (depth >= MAX_NESTING) return textBlock(raw(node, ctx));
      const [head, ...rows] = node.children.map((row) =>
        row.children.map((cell) => inlines(cell.children, depth + 1, ctx)),
      );
      return [{ type: 'table', align: node.align?.map((a) => a ?? null) ?? [], head: head ?? [], rows }];
    }
    case 'definition':
      return [];
    default:
      // 生の HTML（`html`）と、ここで扱わない節。書かれたままを文字で出す
      return textBlock('value' in node && typeof node.value === 'string' ? node.value : raw(node, ctx));
  }
}

function inlines(nodes: PhrasingContent[], depth: number, ctx: Context): MarkdownInline[] {
  return nodes.flatMap((node) => inline(node, depth, ctx));
}

function textOf(value: string): MarkdownInline[] {
  return value ? [{ type: 'text', value }] : [];
}

// 画像と参照形式のリンクの URL は定義から引く。定義の無い参照は null
function resolve(identifier: string, ctx: Context): string | null {
  return ctx.definitions.get(identifier) ?? null;
}

// リンクにできない URL のリンクは、リンクの中の文字だけを出す
function link(url: string | null, children: PhrasingContent[], depth: number, ctx: Context): MarkdownInline[] {
  const inner = inlines(children, depth + 1, ctx);
  const href = url === null ? null : safeHref(url);
  return href === null ? inner : [{ type: 'link', href, children: inner }];
}

// 外部の画像は読み込まない（CSP の img-src も許さない）。http と https の画像は、代わりの文字（無ければ URL）のリンクにする
function image(url: string | null, alt: string | null | undefined): MarkdownInline[] {
  const label = alt ?? '';
  const href = url === null ? null : safeHref(url);
  if (href === null) return textOf(label);
  return [{ type: 'link', href, children: textOf(label || (url ?? '')) }];
}

function inline(node: PhrasingContent, depth: number, ctx: Context): MarkdownInline[] {
  switch (node.type) {
    case 'text':
      return textOf(node.value);
    case 'inlineCode':
      return [{ type: 'code', value: node.value }];
    case 'break':
      return [{ type: 'break' }];
    case 'emphasis':
    case 'strong':
    case 'delete':
      if (depth >= MAX_NESTING) return textOf(raw(node, ctx));
      return [{ type: node.type, children: inlines(node.children, depth + 1, ctx) }];
    case 'link':
      if (depth >= MAX_NESTING) return textOf(raw(node, ctx));
      return link(node.url, node.children, depth, ctx);
    case 'linkReference': {
      if (depth >= MAX_NESTING) return textOf(raw(node, ctx));
      const url = resolve(node.identifier, ctx);
      // 定義の無い参照は、書かれたままを文字にする
      return url === null ? textOf(raw(node, ctx)) : link(url, node.children, depth, ctx);
    }
    case 'image':
      return image(node.url, node.alt);
    case 'imageReference':
      return image(resolve(node.identifier, ctx), node.alt);
    default:
      // 生の HTML（`html`）と、ここで扱わない節。書かれたままを文字で出す
      return textOf('value' in node && typeof node.value === 'string' ? node.value : raw(node, ctx));
  }
}
