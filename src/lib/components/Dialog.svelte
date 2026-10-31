<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import { focusPageHeading } from '../focus-heading.ts';
  import { modalState } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';
  import ToastRegion from './ToastRegion.svelte';

  // kit.js の openDialog / closeDialog。ブラウザの <dialog> の showModal() で開くので、
  // フォーカスの閉じ込めと Esc での閉じは任せる。閉じたら、開いたときにフォーカスのあった要素へ戻す。
  // その要素へ戻せなければ（開いている間に行が作り直された、消えた、押せなくなった）、画面の見出しへ移す。
  // 開閉は open で持つ。footer の snippet には閉じる関数が渡る。
  // Safari と Firefox はクリックしたボタンにフォーカスを移さない（activeElement が body になる）ので、
  // 開く操作を起こした要素は show(trigger) で渡すと確実に戻せる
  // dismissible が偽の間は、閉じる操作（×、Esc、背景、footer に渡す close）をすべて無視する（送っている最中など）。
  // 呼び出し側が open を直に偽にするのは止めない。
  // outsideDismiss を偽にすると、Esc と背景では閉じず、×と footer に渡す close だけで閉じる（二度と出せない値を見せる間、
  // うっかり閉じさせないため）。dismissible と違い、×と close は効く
  let {
    open = $bindable(false),
    dismissible = true,
    outsideDismiss = true,
    danger = false,
    title,
    children,
    footer,
  }: {
    open?: boolean;
    dismissible?: boolean;
    outsideDismiss?: boolean;
    // 取り消せない操作の確認。上辺を赤にする（.dialog-sheet.is-danger）
    danger?: boolean;
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

  // 入力欄か主ボタンを先に、なければ閉じるボタンにフォーカスを置く。ラジオは選ばれているものにだけ置く
  // （矢印キーで動くのは選ばれた項目からなので、選ばれていない項目に置くと読み上げが今の値と食い違う）
  function focusFirst(): void {
    const first =
      dialog.querySelector<HTMLElement>(
        'input:not([type="radio"]), input[type="radio"]:checked, textarea, select, .btn.is-primary',
      ) ?? dialog.querySelector<HTMLElement>('[data-close-dialog]');
    first?.focus();
  }

  $effect(() => {
    if (open && !dialog.open) {
      const active = document.activeElement;
      opener = requestedOpener ?? (active instanceof HTMLElement && active !== document.body ? active : null);
      requestedOpener = null;
      dialog.showModal();
      focusFirst();
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
  // dismissible が偽の間に閉じられたときは、開き直す。Chromium は cancel を1回止めた後、ユーザーの操作が無いまま
  // もう一度 Esc を押されると、cancel を経ずに閉じる（止められない）ため。open は真のまま保つ
  function onclose(): void {
    if (dialog.open) return;
    if ((!dismissible || !outsideDismiss) && open) {
      dialog.showModal();
      focusFirst();
      return;
    }
    open = false;
    const target = opener;
    opener = null;
    // 開いた要素が無い（開いた時点でフォーカスが body にあった）、文書から外れた、
    // 文書にあっても押せなくなった（disabled、隠れた）ときは戻せない
    target?.focus();
    if (target === null || document.activeElement !== target) {
      if (focusLost()) focusPageHeading();
    }
  }

  // フォーカスの行き先が無い（body に落ちた、閉じたダイアログの中に残っている）か。
  // 呼び出し側が先に別の要素（作り直した行のボタンなど）へ移していれば、それを保つ
  function focusLost(): boolean {
    const active = document.activeElement;
    return active === null || active === document.body || dialog.contains(active);
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
    if (outsideDismiss) close();
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
    if (closing && outsideDismiss) close();
  }}
>
  <div class="dialog-sheet" class:is-danger={danger}>
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
