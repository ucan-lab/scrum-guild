<script lang="ts">
  import { toasts } from '../toast.svelte.ts';
  import Icon from './Icon.svelte';

  // kit.js の toast の置き場。画面に1つだけ置き、showToast() で出す。
  // 領域は最初から置いておく（aria-live の領域は、後から足した要素を読み上げられないことがあるため）
</script>

<div class="toasts" aria-live="polite">
  {#each toasts as toast (toast.id)}
    <div class="toast" role="status">
      {#if toast.icon}<Icon name={toast.icon} />{/if}{toast.message}
    </div>
  {/each}
</div>
