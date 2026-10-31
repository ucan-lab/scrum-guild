<script lang="ts">
  import { artViewBox, arts } from '../art.ts';
</script>

<!-- 線画のスプライト。画面に1つだけ置き、Art.svelte が #a-<名前> で引く。隠し方は IconSprite と同じ -->
<div hidden>
  <svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    {#each Object.entries(arts) as [name, body] (name)}
      <symbol id="a-{name}" viewBox={artViewBox}>
        <!-- body は src/lib/art.ts の固定の SVG で、利用者のデータを含まない -->
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        {@html body}
      </symbol>
    {/each}
  </svg>
</div>
