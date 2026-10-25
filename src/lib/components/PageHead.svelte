<script lang="ts" module>
  import type { IconName } from '../icons.ts';

  // 集計の1項目。count が 0 のときは tone を外して素の色で出す
  export type Tally = { tone?: 'danger' | 'warn' | 'ok'; icon?: IconName; label: string; count: number };
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  // kit.js の pageHead。画面の見出し（h1）、上の小さな見出し、集計、右上の操作。
  // focusable は、画面を移った後に見出しへフォーカスを置く画面（作ったワークスペースの画面）が付ける
  let {
    title,
    eyebrow,
    tallies = [],
    actions,
    focusable = false,
  }: { title: string; eyebrow?: string; tallies?: Tally[]; actions?: Snippet; focusable?: boolean } = $props();
</script>

<header class="page-head">
  {#if eyebrow}<span class="page-eyebrow">{eyebrow}</span>{/if}
  <div class="page-head-row">
    <!-- tabindex="-1" は、プログラムからフォーカスを置くため（キーボードの Tab 順には入らない）。値は -1 か未指定だけ -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <h1 class="page-title" tabindex={focusable ? -1 : undefined}>{title}</h1>
    {#if actions}<div class="page-actions">{@render actions()}</div>{/if}
  </div>
  {#if tallies.length > 0}
    <dl class="tally">
      <!-- 同じラベルが2つあっても落ちないよう、key は添字にする（並びは画面が決め、入れ替えない） -->
      {#each tallies as tally, index (index)}
        <div class={tally.count && tally.tone ? `is-${tally.tone}` : undefined}>
          <dt>
            {#if tally.icon}<Icon name={tally.icon} />{/if}{tally.label}
          </dt>
          <dd>{tally.count}</dd>
        </div>
      {/each}
    </dl>
  {/if}
</header>
