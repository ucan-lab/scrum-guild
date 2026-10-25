<script lang="ts">
  import type { MarkdownBlock, MarkdownInline } from '../markdown.ts';
  import { MARKDOWN_PAGE_SIZE, pagesOf } from '../markdown-render.ts';
  import { t } from '../vocabulary.svelte.ts';

  // 変換済みの安全な節（markdown.ts の MarkdownBlock）を再帰で描く。枠は components.css の .doc-box。
  // HTML の文字列を差し込む記法と、インラインの style 属性（CSP が止める）は使わない。リンクと画像の規則は markdown.ts が持つ。
  // headingStart は `#` を何段の見出しにするか（既定 3）。`##` はその次の段で、h6 で止める。見た目の大きさは Markdown の段（.doc-h1 から .doc-h6）で決まる。
  // busy は、次の本文の変換を待っている間（今の描画は前の本文）と、段階の描画で描き終わるまで
  let {
    blocks,
    headingStart = 3,
    busy = false,
  }: { blocks: MarkdownBlock[]; headingStart?: number; busy?: boolean } = $props();

  // チェックリストの箱と項目の中身を結ぶ id は、同じ画面に本文が並んでも衝突しないよう、部品ごとの id を前に付ける
  const uid = $props.id();
  // 数でない値は既定の3、範囲外は1と6に丸める
  const start = $derived(Number.isNaN(headingStart) ? 3 : Math.min(6, Math.max(1, Math.trunc(headingStart))));
  const newTabId = `${uid}-newtab`;
  const level = (depth: number) => `h${Math.min(6, start + depth - 1)}`;
</script>

{#snippet inlines(nodes: MarkdownInline[])}
  {#each nodes as node, i (i)}
    {#if node.type === 'text'}{node.value}
    {:else if node.type === 'literal'}<span class="doc-literal">{node.value}</span>
    {:else if node.type === 'code'}<code>{node.value}</code>
    {:else if node.type === 'break'}<br />
    {:else if node.type === 'emphasis'}<em>{@render inlines(node.children)}</em>
    {:else if node.type === 'strong'}<strong>{@render inlines(node.children)}</strong>
    {:else if node.type === 'delete'}<del>{@render inlines(node.children)}</del>
    {:else if node.type === 'link'}
      <!-- 外の絶対 URL（markdown.ts が http と https に絞る）で、画面の経路ではないので resolve() は通さない -->
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
      <a href={node.href} rel="noopener noreferrer" target="_blank" aria-describedby={newTabId}
        >{@render inlines(node.children)}</a
      >
    {/if}
  {/each}
{/snippet}

{#snippet cell(tag: 'th' | 'td', content: MarkdownInline[], align: 'left' | 'center' | 'right' | null)}
  <svelte:element this={tag} scope={tag === 'th' ? 'col' : undefined} class={align ? `is-${align}` : undefined}
    >{@render inlines(content)}</svelte:element
  >
{/snippet}

<!-- tight は、密なリストの項目の中。段落を <p> で包まない。path は、チェックリストの id を一意にする節の位置。offset は、頁の先頭の節の添字 -->
{#snippet blockList(nodes: MarkdownBlock[], tight: boolean, path: string, offset: number = 0)}
  {#each nodes as node, k (k)}
    {@const i = offset + k}
    {#if node.type === 'paragraph'}
      {#if tight}{@render inlines(node.children)}{:else}<p>{@render inlines(node.children)}</p>{/if}
    {:else if node.type === 'literal'}
      <p class="doc-literal">{node.value}</p>
    {:else if node.type === 'heading'}
      <svelte:element this={level(node.depth)} class={`doc-h${node.depth}`}
        >{@render inlines(node.children)}</svelte:element
      >
    {:else if node.type === 'quote'}
      <blockquote>{@render blockList(node.children, false, `${path}-${i}`)}</blockquote>
    {:else if node.type === 'list'}
      <!-- 項目の中で node を読むと、段階の描画で節が作り直されるたびに、描き済みの全項目が描き直される。変わらない値は、ここで1回だけ取り出す -->
      {@const tight = node.tight}
      <!-- 項目の印を消すチェックリストは、Safari の読み上げが一覧として扱わなくなるので role="list" を付ける -->
      <svelte:element
        this={node.ordered ? 'ol' : 'ul'}
        start={node.ordered && node.start !== 1 ? node.start : undefined}
        role={!node.ordered && node.items.some((item) => item.checked !== null) ? 'list' : undefined}
      >
        {#each pagesOf(node.items) as page, p (p)}
          {#each page as item, q (q)}
            {@const j = p * MARKDOWN_PAGE_SIZE + q}
            {#if item.checked === null}
              <li>{@render blockList(item.children, tight, `${path}-${i}-${j}`)}</li>
            {:else}
              {@const labelId = `${uid}-task${path}-${i}-${j}`}
              <li class="is-task">
                <input type="checkbox" checked={item.checked} disabled aria-labelledby={labelId} />
                <div id={labelId}>{@render blockList(item.children, tight, `${path}-${i}-${j}`)}</div>
              </li>
            {/if}
          {/each}
        {/each}
      </svelte:element>
    {:else if node.type === 'code'}
      <pre><code>{node.value}</code></pre>
    {:else if node.type === 'rule'}
      <hr />
    {:else if node.type === 'table'}
      {@const align = node.align}
      <div class="doc-table">
        <table>
          <thead>
            <tr>
              {#each node.head as content, c (c)}{@render cell('th', content, align[c] ?? null)}{/each}
            </tr>
          </thead>
          <tbody>
            {#each pagesOf(node.rows) as page, p (p)}
              {#each page as row, r (r)}
                <tr>
                  {#each row as content, c (c)}{@render cell('td', content, align[c] ?? null)}{/each}
                </tr>
              {/each}
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/each}
{/snippet}

<div class="doc-box" aria-busy={busy ? 'true' : undefined}>
  {#each pagesOf(blocks) as page, p (p)}
    {@render blockList(page, false, '', p * MARKDOWN_PAGE_SIZE)}
  {/each}
  <!-- 全部のリンクが指す補足。リンクの名前にも、チェックリストの箱の名前（aria-labelledby）にも入らない -->
  <span id={newTabId} hidden>{t('markdownNewTab')}</span>
</div>
