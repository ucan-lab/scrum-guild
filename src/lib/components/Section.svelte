<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '../vocabulary.svelte.ts';

  // kit.js の section。id は見出しと節を結ぶ（aria-labelledby）ので、画面の中で一意にする
  let {
    id,
    title,
    count,
    hint,
    folded = false,
    foldedHint,
    children,
  }: {
    id: string;
    title: string;
    count?: number;
    hint?: string;
    folded?: boolean;
    foldedHint?: string;
    children: Snippet;
  } = $props();
</script>

{#if folded}
  <details class="section is-folded">
    <summary class="section-head">
      <h2 class="section-title" {id}>{title}</h2>
      {#if count != null}<span class="section-count">{count} {t('countUnit')}</span>{/if}
      <span class="section-hint">{foldedHint ?? t('sectionOpen')}</span>
    </summary>
    {@render children()}
  </details>
{:else}
  <section class="section" aria-labelledby={id}>
    <div class="section-head">
      <h2 class="section-title" {id}>{title}</h2>
      {#if count != null}<span class="section-count">{count} {t('countUnit')}</span>{/if}
      {#if hint}<span class="section-hint">{hint}</span>{/if}
    </div>
    {@render children()}
  </section>
{/if}
