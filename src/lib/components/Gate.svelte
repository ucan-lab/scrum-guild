<script lang="ts">
  import type { Snippet } from 'svelte';

  // 枠の外の画面（組織の選択、見つからない、運用の仮の画面）の外側。中に GateSheet を縦に並べる
  let { children }: { children: Snippet } = $props();
</script>

<div class="gate">
  <div class="gate-stack">{@render children()}</div>
</div>
