<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import Dialog from './Dialog.svelte';

  // kit.js の DIALOGS.discardDraft / deleteTask。アプリの中の確認のダイアログ（ブラウザの confirm は使わない）。
  // ask() で開き、続ける（confirm）なら true、やめる（cancel、×、Esc、背景）なら false で答える。
  // 安全な側（cancel）を主ボタンにし、開いたときのフォーカスもそこへ置く（Dialog が主ボタンへ置く）。
  // 答えは、ダイアログが閉じて、フォーカスが開いた元へ戻った後に返す。呼び出し側が答えの後にフォーカスを動かしても、
  // Dialog の戻しに上書きされない。部品が外れたときに答えを待っていれば、false で返す
  let {
    title,
    confirmLabel,
    cancelLabel,
    danger = false,
    children,
  }: {
    title: string;
    confirmLabel: string;
    cancelLabel: string;
    danger?: boolean;
    children: Snippet;
  } = $props();

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let pending: ((confirmed: boolean) => void) | null = null;
  let confirmed = false;

  export function ask(trigger?: HTMLElement | null): Promise<boolean> {
    // 答えを待っている問いがあれば、やめた扱いで終える
    pending?.(false);
    return new Promise((resolve) => {
      pending = resolve;
      confirmed = false;
      dialog?.show(trigger);
    });
  }

  $effect(() => {
    if (open || pending === null) return;
    const resolve = pending;
    const answer = confirmed;
    pending = null;
    // close の event は閉じた後の別の仕事として届く。flush を待ってから、さらに1つ後ろに返す
    void tick().then(() => setTimeout(() => resolve(answer), 0));
  });

  $effect(() => () => {
    pending?.(false);
    pending = null;
  });
</script>

<Dialog bind:this={dialog} bind:open {title} {danger}>
  {@render children()}
  {#snippet footer(close)}
    <button class="btn is-primary" type="button" onclick={close}>{cancelLabel}</button>
    <button
      class="btn"
      class:is-danger={danger}
      type="button"
      onclick={() => {
        confirmed = true;
        close();
      }}
    >
      {confirmLabel}
    </button>
  {/snippet}
</Dialog>
