<script lang="ts">
  import type { ArtName } from '../art.ts';

  // kit.js の art。装飾なので読み上げから外す（何が出る場所かは隣の文が伝える）
  // lead は「最初にやること」の先頭に置く小さい形
  let { name, lead = false }: { name: ArtName; lead?: boolean } = $props();
</script>

<svg class="art" class:is-lead={lead} aria-hidden="true"><use href="#a-{name}" /></svg>
