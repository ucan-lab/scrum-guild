<script lang="ts">
  import { sharedMarkdownLoader } from '../markdown-async.ts';
  import { MarkdownSession, type MarkdownView } from '../markdown-session.ts';
  import MarkdownBlocks from './MarkdownBlocks.svelte';
  import MarkdownPlain from './MarkdownPlain.svelte';

  // Markdown の本文。変換は Worker で行い（markdown-parser.ts。1秒で止める）、結果は覚える（markdown-session.ts）。
  // 変換を待つ間は、前の本文の描画を残す（無ければ本文を文字のまま出す）。時間切れ、失敗、Worker が使えないときは、
  // 本文を文字のまま出し、注記を添える（.doc-box.is-plain）。描くのは MarkdownBlocks。
  // headingStart は `#` を何段の見出しにするか（既定 3）
  let { source, headingStart = 3 }: { source: string; headingStart?: number } = $props();

  // 節の木は大きい。中身を追跡させないよう、まるごと入れ替える（$state.raw）
  let view = $state.raw<MarkdownView>({ status: 'loading', blocks: null });
  const session = new MarkdownSession(sharedMarkdownLoader(), (next) => {
    view = next;
  });

  // サーバーの描画（svelte/server）では動かない。ここが動くのはブラウザだけ
  $effect(() => {
    session.show(source);
    return () => session.cancel();
  });
</script>

{#if view.blocks}
  <MarkdownBlocks blocks={view.blocks} {headingStart} busy={view.status === 'loading'} />
{:else}
  <MarkdownPlain {source} noted={view.status === 'plain'} busy={view.status === 'loading'} />
{/if}
