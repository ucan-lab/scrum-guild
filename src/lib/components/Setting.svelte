<script lang="ts">
  import type { Snippet } from 'svelte';

  // admin.html の setting。左に見出しと説明、右に中身。組織の管理の節。`.settings` の中に並べる
  let { title, description, children }: { title: string; description: string; children: Snippet } = $props();

  const titleId = $props.id();
</script>

<section class="setting" aria-labelledby={titleId}>
  <div class="setting-head">
    <h2 class="setting-title" id={titleId}>{title}</h2>
    <p class="setting-desc">{description}</p>
  </div>
  <div class="setting-body">{@render children()}</div>
</section>
