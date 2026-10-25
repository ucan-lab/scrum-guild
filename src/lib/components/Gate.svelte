<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { resetToDefaults } from '../organization.svelte.ts';

  // 枠の外の画面（組織の選択、見つからない、読み込みの失敗、運用の仮の画面）の外側。中に GateSheet を縦に並べる。
  // 画面の本文なので main にする。組織の外の画面は、どの組織の値も持ち越さず、テーマと言葉づかいを既定に戻す
  let { children }: { children: Snippet } = $props();

  onMount(resetToDefaults);
</script>

<main class="gate">
  <div class="gate-stack">{@render children()}</div>
</main>
