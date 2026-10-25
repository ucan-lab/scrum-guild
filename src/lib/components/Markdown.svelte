<script lang="ts">
  import { sharedMarkdownLoader } from '../markdown-async.ts';
  import { bindMarkdownView } from '../markdown-view.svelte.ts';
  import MarkdownBlocks from './MarkdownBlocks.svelte';
  import MarkdownPlain from './MarkdownPlain.svelte';

  // Markdown の本文。変換は Worker で行い（markdown-parser.ts。1秒で止める）、結果は覚える（markdown-session.ts）。
  // 結果の節は、1フレームの時間の予算ごとに少しずつ描く（markdown-render.ts。短い本文は1回で全部）。
  // 変換を待つ間と、描き終わるまでは、枠に aria-busy を付ける。待つ間は前の本文の描画を残す（無ければ本文を文字のまま出す）。
  // 時間切れ、失敗、Worker が使えないときは、本文を文字のまま出し、注記を添える（.doc-box.is-plain）。描くのは MarkdownBlocks。
  // 配線（本文が変わったら表示を頼み直し、消えたら待ちと描きかけを取り下げる）は bindMarkdownView が持つ。
  // headingStart は `#` を何段の見出しにするか（既定 3）
  let { source, headingStart = 3 }: { source: string; headingStart?: number } = $props();

  const markdown = bindMarkdownView(() => source, sharedMarkdownLoader());
</script>

{#if markdown.view.blocks}
  <MarkdownBlocks
    blocks={markdown.view.blocks}
    {headingStart}
    busy={markdown.view.status === 'loading' || markdown.view.rendering}
  />
{:else}
  <MarkdownPlain {source} noted={markdown.view.status === 'plain'} busy={markdown.view.status === 'loading'} />
{/if}
