<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '../vocabulary.svelte.ts';

  // kit.js の section。id は見出しと節を結ぶ（aria-labelledby）ので、画面の中で一意にする
  let {
    id,
    title,
    count,
    hint,
    children,
  }: { id: string; title: string; count?: number; hint?: string; children: Snippet } = $props();
</script>

<section class="section" aria-labelledby={id}>
  <div class="section-head">
    <h2 class="section-title" {id}>{title}</h2>
    {#if count != null}<span class="section-count">{count} {t('countUnit')}</span>{/if}
    {#if hint}<span class="section-hint">{hint}</span>{/if}
  </div>
  {@render children()}
</section>
