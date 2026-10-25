<script lang="ts">
  import { iconViewBox, icons } from '../icons.ts';
</script>

<!-- アイコンのスプライト。画面に1つだけ置き、Icon.svelte が #i-<名前> で引く。
  隠すのは style 属性でなく hidden 属性（inline の style は CSP のハッシュから漏れて止まる） -->
<div hidden>
  <svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    {#each Object.entries(icons) as [name, body] (name)}
      <symbol id="i-{name}" viewBox={iconViewBox}>
        <!-- body は src/lib/icons.ts の固定の SVG で、利用者のデータを含まない -->
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        {@html body}
      </symbol>
    {/each}
  </svg>
</div>
