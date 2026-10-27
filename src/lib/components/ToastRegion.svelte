<script lang="ts">
  import { dismissToast, modalState, pauseToast, resumeToast, toasts } from '../toast.svelte.ts';
  import Icon from './Icon.svelte';

  // kit.js の toast の置き場。showToast() で出す。画面の外側に1つ（+layout.svelte）と、各ダイアログの中に1つ（inDialog）置く。
  // モーダルのダイアログが開くと外側は inert になり、トップレイヤーに出し直しても（popover="manual" で確かめた）
  // 外側の要素は inert のままで、読み上げも届かない。そのためダイアログの中の領域に出し、外側の領域は隠す。
  // 領域は最初から置いておく（aria-live の領域は、後から足した要素を読み上げられないことがあるため）。
  // 操作の付いたトーストは、文の後ろにボタン（.toast-action）を出し、押したらそのトーストを消す。押すと画面が動くので、
  // ダイアログの中の領域には出さず、外側の領域だけに出す。ポインターかフォーカスがある間は、消すまでの時間を止める
  let { inDialog = false }: { inDialog?: boolean } = $props();

  const shown = $derived(inDialog ? toasts.filter((toast) => toast.action === undefined) : toasts);
</script>

<div class="toasts" aria-live="polite" hidden={!inDialog && modalState.openCount > 0}>
  {#each shown as toast (toast.id)}
    {#if toast.action}
      {@const action = toast.action}
      <div
        class="toast"
        role="status"
        onmouseenter={() => pauseToast(toast.id)}
        onmouseleave={() => resumeToast(toast.id)}
        onfocusin={() => pauseToast(toast.id)}
        onfocusout={() => resumeToast(toast.id)}
      >
        {#if toast.icon}<Icon name={toast.icon} />{/if}<span>{toast.message}</span>
        <button
          class="toast-action"
          type="button"
          onclick={() => {
            dismissToast(toast.id);
            action.run();
          }}>{action.label}</button
        >
      </div>
    {:else}
      <div class="toast" role="status">
        {#if toast.icon}<Icon name={toast.icon} />{/if}<span>{toast.message}</span>
      </div>
    {/if}
  {/each}
</div>
