<script lang="ts">
  import { modalState, toasts } from '../toast.svelte.ts';
  import Icon from './Icon.svelte';

  // kit.js の toast の置き場。showToast() で出す。画面の外側に1つ（+layout.svelte）と、各ダイアログの中に1つ（inDialog）置く。
  // モーダルのダイアログが開くと外側は inert になり、トップレイヤーに出し直しても（popover="manual" で確かめた）
  // 外側の要素は inert のままで、読み上げも届かない。そのためダイアログの中の領域に出し、外側の領域は隠す。
  // 領域は最初から置いておく（aria-live の領域は、後から足した要素を読み上げられないことがあるため）
  let { inDialog = false }: { inDialog?: boolean } = $props();
</script>

<div class="toasts" aria-live="polite" hidden={!inDialog && modalState.openCount > 0}>
  {#each toasts as toast (toast.id)}
    <div class="toast" role="status">
      {#if toast.icon}<Icon name={toast.icon} />{/if}{toast.message}
    </div>
  {/each}
</div>
