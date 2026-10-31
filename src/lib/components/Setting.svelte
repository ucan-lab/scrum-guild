<script lang="ts">
  import type { Snippet } from 'svelte';

  // admin.html の setting。左に見出しと説明、右に中身。組織の管理の節。`.settings` の中に並べる
  let { title, description, children }: { title: string; description: string; children: Snippet } = $props();

  const titleId = $props.id();
  let heading = $state<HTMLElement>();

  // 節を読み直せた後に、題へフォーカスを移す（押した「もう一度試す」が消えるため）
  export function focusTitle(): void {
    heading?.focus();
  }
</script>

<section class="setting" aria-labelledby={titleId}>
  <div class="setting-head">
    <!-- tabindex="-1" は、読み直した後にプログラムからフォーカスを置くため（focusTitle）。Tab の順には入らない -->
    <h2 class="setting-title" id={titleId} tabindex="-1" bind:this={heading}>{title}</h2>
    <p class="setting-desc">{description}</p>
  </div>
  <div class="setting-body">{@render children()}</div>
</section>
