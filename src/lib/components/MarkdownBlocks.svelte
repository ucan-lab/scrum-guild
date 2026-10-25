<script lang="ts">
  import type { MarkdownBlock, MarkdownInline } from '../markdown.ts';

  // 変換済みの安全な節（markdown.ts の MarkdownBlock）を再帰で描く。枠は components.css の .doc-box。
  // HTML の文字列を差し込む記法と、インラインの style 属性（CSP が止める）は使わない。リンクと画像の規則は markdown.ts が持つ。
  // headingStart は `#` を何段の見出しにするか（既定 3）。`##` はその次の段で、h6 で止める。見た目の大きさは Markdown の段（.doc-h1 から .doc-h6）で決まる
  let { blocks, headingStart = 3 }: { blocks: MarkdownBlock[]; headingStart?: number } = $props();

  const start = $derived(Math.min(6, Math.max(1, Math.trunc(headingStart) || 3)));
  const level = (depth: number) => `h${Math.min(6, start + depth - 1)}`;
</script>

{#snippet inlines(nodes: MarkdownInline[])}
  {#each nodes as node, i (i)}
    {#if node.type === 'text'}{node.value}
    {:else if node.type === 'code'}<code>{node.value}</code>
    {:else if node.type === 'break'}<br />
    {:else if node.type === 'emphasis'}<em>{@render inlines(node.children)}</em>
    {:else if node.type === 'strong'}<strong>{@render inlines(node.children)}</strong>
    {:else if node.type === 'delete'}<del>{@render inlines(node.children)}</del>
    {:else if node.type === 'link'}
      <!-- 外の絶対 URL（markdown.ts が http と https に絞る）で、画面の経路ではないので resolve() は通さない -->
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
      <a href={node.href} rel="noopener noreferrer" target="_blank">{@render inlines(node.children)}</a>
    {/if}
  {/each}
{/snippet}

{#snippet cell(tag: 'th' | 'td', content: MarkdownInline[], align: 'left' | 'center' | 'right' | null)}
  <svelte:element this={tag} class={align ? `is-${align}` : undefined}>{@render inlines(content)}</svelte:element>
{/snippet}

{#snippet blockList(nodes: MarkdownBlock[])}
  {#each nodes as node, i (i)}
    {#if node.type === 'paragraph'}
      <p>{@render inlines(node.children)}</p>
    {:else if node.type === 'heading'}
      <svelte:element this={level(node.depth)} class={`doc-h${node.depth}`}
        >{@render inlines(node.children)}</svelte:element
      >
    {:else if node.type === 'quote'}
      <blockquote>{@render blockList(node.children)}</blockquote>
    {:else if node.type === 'list'}
      <svelte:element
        this={node.ordered ? 'ol' : 'ul'}
        start={node.ordered && node.start !== 1 ? node.start : undefined}
      >
        {#each node.items as item, j (j)}
          {#if item.checked === null}
            <li>{@render blockList(item.children)}</li>
          {:else}
            <li class="is-task">
              <input type="checkbox" checked={item.checked} disabled />
              <div>{@render blockList(item.children)}</div>
            </li>
          {/if}
        {/each}
      </svelte:element>
    {:else if node.type === 'code'}
      <pre><code>{node.value}</code></pre>
    {:else if node.type === 'rule'}
      <hr />
    {:else if node.type === 'table'}
      <div class="doc-table">
        <table>
          <thead>
            <tr>
              {#each node.head as content, c (c)}{@render cell('th', content, node.align[c] ?? null)}{/each}
            </tr>
          </thead>
          <tbody>
            {#each node.rows as row, r (r)}
              <tr>
                {#each row as content, c (c)}{@render cell('td', content, node.align[c] ?? null)}{/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/each}
{/snippet}

<div class="doc-box">{@render blockList(blocks)}</div>
