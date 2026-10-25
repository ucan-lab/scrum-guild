<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '../vocabulary.svelte.ts';
  import BrandMark from './BrandMark.svelte';

  // 枠の外の画面の紙1枚。brand は先頭の紙だけに付け、その紙の見出しを h1 にする（ほかの紙は h2）
  let { title, brand = false, children }: { title?: string; brand?: boolean; children: Snippet } = $props();
</script>

<section class="gate-sheet">
  {#if brand}
    <div class="gate-brand">
      <BrandMark />
      <span class="brand-name">{t('appName')}</span>
    </div>
  {/if}
  {#if title}
    {#if brand}<h1 class="gate-title">{title}</h1>{:else}<h2 class="dialog-title">{title}</h2>{/if}
  {/if}
  {@render children()}
</section>
