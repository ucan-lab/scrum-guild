<script lang="ts">
  import type { Snippet } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { drawerState } from '../drawer.svelte.ts';
  import { inertOutside } from '../inert-outside.ts';
  import { modalState } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // kit.js の drawerHtml の枠（幕、上の帯の広げる／閉じる、中身の置き場）。右から出る引き出しで、部品が置かれている間が開いている間。
  // 開閉は呼び出し側が部品を置く／外すで決める。閉じる操作（×、幕、Esc）は onrequestclose を呼ぶだけで、
  // 書きかけの確認などは呼び出し側が決める（確認の後に部品を外す）。
  // 横に出した形は aria-modal="true" で、外側を inert にする（フォーカスも読み上げも届かない。幕とダイアログとトーストは残す）。
  // 広げた形は左のメニューを押せるので aria-modal="false" にし、幕を外し、inert にしない。広げた形は drawerState が持つ。
  // Esc は、ほかのモーダルのダイアログ（確認など）が開いている間と、中の入力欄が Esc を受けた（preventDefault した）ときは閉じない。
  // 開いたらフォーカスを閉じるボタンへ置く。見出しなどへ移すのは中身（呼び出し側）が決める
  let {
    labelledBy,
    busy = false,
    onrequestclose,
    top,
    children,
  }: {
    // 見出しの文字を持つ要素の id（dialog の名前）
    labelledBy: string;
    busy?: boolean;
    onrequestclose: () => void;
    // 上の帯の左（出どころの印など）
    top?: Snippet;
    children: Snippet;
  } = $props();

  let drawerElement = $state<HTMLElement>();
  let scrimElement = $state<HTMLElement>();
  let closeButton = $state<HTMLButtonElement>();

  // 引き出しがもともと全幅になる 620px 以下では、広げた形を無視して横に出した形（モーダル）として扱う。
  // 広げても見た目が変わらず、左のメニューも覆われているので、幕と inert で外側を操作できなくするのが正しい
  const narrow = new MediaQuery('max-width: 620px');
  const full = $derived(drawerState.full && !narrow.current);
  const modal = $derived(!full);
  const sizeLabel = $derived(full ? t('drawerShrink') : t('drawerExpand'));

  $effect(() => {
    closeButton?.focus();
  });

  $effect(() => {
    if (!modal || drawerElement === undefined) return;
    return inertOutside(
      drawerElement,
      (sibling) => sibling === scrimElement || sibling.tagName === 'DIALOG' || sibling.classList.contains('toasts'),
    );
  });
</script>

<svelte:window
  onkeydown={(event) => {
    // 日本語の変換中の Esc は変換の取り消し。keyCode 229 は、isComposing が偽になる Safari の変換確定の直後の Esc も含む
    if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
    if (event.defaultPrevented || modalState.openCount > 0) return;
    event.preventDefault();
    onrequestclose();
  }}
/>

<!-- 幕を押して閉じるのは、マウスと指のため。キーボードと読み上げには閉じるボタンと Esc がある -->
<div class="scrim" bind:this={scrimElement} aria-hidden="true" onclick={onrequestclose}></div>
<div
  class="drawer"
  class:is-full={full}
  bind:this={drawerElement}
  role="dialog"
  aria-modal={modal}
  aria-labelledby={labelledBy}
  aria-busy={busy}
>
  <div class="drawer-top">
    {#if top}{@render top()}{/if}
    <span class="drawer-tools">
      <button
        class="pill drawer-size"
        type="button"
        aria-label={sizeLabel}
        title={sizeLabel}
        onclick={() => (drawerState.full = !full)}
      >
        <Icon name={full ? 'shrink' : 'expand'} />
      </button>
      <button
        class="pill drawer-close"
        type="button"
        aria-label={t('close')}
        bind:this={closeButton}
        onclick={onrequestclose}
      >
        <Icon name="x" />
      </button>
    </span>
  </div>
  {@render children()}
</div>
