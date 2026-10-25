<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import { modalState } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';
  import ToastRegion from './ToastRegion.svelte';

  // kit.js の openDialog / closeDialog。ブラウザの <dialog> の showModal() で開くので、
  // フォーカスの閉じ込めと Esc での閉じは任せる。閉じたら、開いたときにフォーカスのあった要素へ戻す。
  // 開閉は open で持つ。footer の snippet には閉じる関数が渡る。
  // Safari と Firefox はクリックしたボタンにフォーカスを移さない（activeElement が body になる）ので、
  // 開く操作を起こした要素は show(trigger) で渡すと確実に戻せる
  // dismissible が偽の間は、閉じる操作（×、Esc、背景、footer に渡す close）をすべて無視する（送っている最中など）。
  // 呼び出し側が open を直に偽にするのは止めない
  let {
    open = $bindable(false),
    dismissible = true,
    title,
    children,
    footer,
  }: {
    open?: boolean;
    dismissible?: boolean;
    title: string;
    children: Snippet;
    footer?: Snippet<[close: () => void]>;
  } = $props();

  const titleId = $props.id();
  let dialog: HTMLDialogElement;
  // フォーカスを戻す先。show() が渡した要素か、開いた時点でフォーカスのあった要素
  let opener: HTMLElement | null = null;
  let requestedOpener: HTMLElement | null = null;
  // 背景（dialog 自身）を押し始めたか、離したか。押し始めと離した所が違うと、click は共通の祖先の
  // dialog に届くので、click の target だけでは中と外をまたいだドラッグを見分けられない
  let pressedOnBackdrop = false;
  let releasedOnBackdrop = false;

  export function show(trigger?: HTMLElement | null): void {
    requestedOpener = trigger ?? null;
    open = true;
  }

  function close(): void {
    if (!dismissible) return;
    open = false;
  }

  $effect(() => {
    if (open && !dialog.open) {
      const active = document.activeElement;
      opener = requestedOpener ?? (active instanceof HTMLElement && active !== document.body ? active : null);
      requestedOpener = null;
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

  // 開いている間だけ数える。閉じても、開いたまま画面ごと消えても戻る
  $effect(() => {
    if (!open) return;
    // 数を読みながら書くので、この effect の依存に入れない
    untrack(() => modalState.openCount++);
    return () => untrack(() => modalState.openCount--);
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

<!-- 背景を押して閉じるのは、押し始めと離した所の両方が dialog 自身のときだけ。キーボードでは Esc で閉じられる -->
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
  onpointerdown={(event) => {
    pressedOnBackdrop = event.target === dialog;
  }}
  onpointerup={(event) => {
    releasedOnBackdrop = event.target === dialog;
  }}
  onclick={(event) => {
    const closing = pressedOnBackdrop && releasedOnBackdrop && event.target === dialog;
    pressedOnBackdrop = false;
    releasedOnBackdrop = false;
    if (closing) close();
  }}
>
  <div class="dialog-sheet">
    <div class="dialog-head">
      <h2 class="dialog-title" id={titleId}>{title}</h2>
      <button
        class="pill"
        type="button"
        data-close-dialog
        aria-label={t('close')}
        aria-disabled={!dismissible}
        onclick={close}
      >
        <Icon name="x" />
      </button>
    </div>
    <div class="dialog-body">{@render children()}</div>
    {#if footer}<div class="dialog-foot">{@render footer(close)}</div>{/if}
  </div>
  <ToastRegion inDialog />
</dialog>
