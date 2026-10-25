<script lang="ts">
  import type { Snippet } from 'svelte';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // kit.js の openDialog / closeDialog。ブラウザの <dialog> の showModal() で開くので、
  // フォーカスの閉じ込めと Esc での閉じは任せる。閉じたら、開いたときにフォーカスのあった要素へ戻す。
  // 開閉は open で持つ。footer の snippet には閉じる関数が渡る
  let {
    open = $bindable(false),
    title,
    children,
    footer,
  }: {
    open?: boolean;
    title: string;
    children: Snippet;
    footer?: Snippet<[close: () => void]>;
  } = $props();

  const titleId = $props.id();
  let dialog: HTMLDialogElement;
  let opener: HTMLElement | null = null;

  function close(): void {
    open = false;
  }

  $effect(() => {
    if (open && !dialog.open) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      // 入力欄か主ボタンを先に、なければ閉じるボタンにフォーカスを置く
      const first =
        dialog.querySelector<HTMLElement>('input, textarea, select, .btn.is-primary') ??
        dialog.querySelector<HTMLElement>('[data-close-dialog]');
      first?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  });

  // Esc でも、閉じるボタンでも、背景を押してもここに来る。close は非同期に届くので、
  // 届く前に開き直されていたら（dialog.open が true）何もしない
  function onclose(): void {
    if (dialog.open) return;
    open = false;
    opener?.focus();
    opener = null;
  }
</script>

<!-- 背景（dialog 自身）を押したときだけ閉じる。キーボードでは Esc で閉じられる -->
<dialog
  class="dialog"
  bind:this={dialog}
  aria-labelledby={titleId}
  oncancel={(event) => {
    // Esc。ブラウザに閉じさせず、閉じた状態を open にすぐ反映する（close の event は遅れて届くので、
    // その間に開き直すと open が true のまま変わらず、開かなくなる）
    event.preventDefault();
    close();
  }}
  {onclose}
  onclick={(event) => {
    if (event.target === dialog) close();
  }}
>
  <div class="dialog-sheet">
    <div class="dialog-head">
      <h2 class="dialog-title" id={titleId}>{title}</h2>
      <button class="pill" type="button" data-close-dialog aria-label={t('close')} onclick={close}>
        <Icon name="x" />
      </button>
    </div>
    <div class="dialog-body">{@render children()}</div>
    {#if footer}<div class="dialog-foot">{@render footer(close)}</div>{/if}
  </div>
</dialog>
