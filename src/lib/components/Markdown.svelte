<script lang="ts">
  import { sharedMarkdownParser } from '../markdown-async.ts';
  import type { MarkdownBlock } from '../markdown.ts';
  import MarkdownBlocks from './MarkdownBlocks.svelte';

  // Markdown の本文。変換は Worker で行い（markdown-parser.ts。1秒で止める）、変換が終わるまでと、時間切れや Worker が
  // 使えないときは、本文を文字のまま出す（.doc-box.is-plain）。描くのは MarkdownBlocks。
  // headingStart は `#` を何段の見出しにするか（既定 3）
  let { source, headingStart = 3 }: { source: string; headingStart?: number } = $props();

  // どの本文の結果か。source が変わったら、前の本文の結果は使わない
  let parsed = $state<{ source: string; blocks: MarkdownBlock[] } | null>(null);
  const blocks = $derived(parsed?.source === source ? parsed.blocks : null);

  // サーバーの描画（svelte/server）では動かない。ここが動くのはブラウザだけ
  $effect(() => {
    const requested = source;
    const request = sharedMarkdownParser().parse(requested);
    let stale = false;
    void request.result.then((result) => {
      if (!stale && result) parsed = { source: requested, blocks: result };
    });
    return () => {
      stale = true;
      request.cancel();
    };
  });
</script>

{#if blocks}
  <MarkdownBlocks {blocks} {headingStart} />
{:else}
  <div class="doc-box is-plain">{source}</div>
{/if}
