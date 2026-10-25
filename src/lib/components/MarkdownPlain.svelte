<script lang="ts">
  import { t } from '../vocabulary.svelte.ts';

  // 本文を書かれたまま文字で出す（.doc-box.is-plain）。変換を待つ間（busy）と、時間切れや失敗（noted）に使う。
  // noted のときは、整形していないことを枠の上に添える。待つ間は一瞬なので添えない
  let { source, noted = false, busy = false }: { source: string; noted?: boolean; busy?: boolean } = $props();
</script>

{#if noted}<p class="props-note">{t('markdownPlainNote')}</p>{/if}
<div class="doc-box is-plain" aria-busy={busy ? 'true' : undefined}>{source}</div>
