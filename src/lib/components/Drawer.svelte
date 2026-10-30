<script lang="ts">
  import type { Snippet } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { effectiveTaskOpenMode, type TaskOpenMode } from '../drawer.svelte.ts';
  import type { DictionaryKey } from '../../shared/vocabulary.ts';
  import { inertOutside } from '../inert-outside.ts';
  import { modalState } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // kit.js の drawerHtml の枠（幕、上の帯の開き方／閉じる、中身の置き場）。部品が置かれている間が開いている間。
  // 開閉は呼び出し側が部品を置く／外すで決める。閉じる操作（×、幕、Esc）は onrequestclose を呼ぶだけで、
  // 書きかけの確認などは呼び出し側が決める（確認の後に部品を外す）。
  // 横と真ん中は aria-modal="true" で、幕を出し、外側を inert にする（フォーカスも読み上げも届かない。幕とダイアログとトーストは残す）。
  // ページ全体は通常の画面（role="region"）として同じ中身を出し、幕も inert も無い（左のメニューを押せる）。
  // 開き方の切り替えは、押した時点で実行するボタンの組にする。<select> は Windows と Linux で矢印キーを押すだけで change が出て、
  // 確認なしに遷移してしまうため使わない。
  // Esc は、ほかのモーダルのダイアログ（確認など）が開いている間と、中の入力欄が Esc を受けた（preventDefault した）ときは閉じない。
  // 日本語の変換中の Esc は変換の取り消しなので閉じない。ページ全体は引き出しの外（左のメニューなど）にフォーカスがあるときの Esc で閉じない。
  // 開いたらフォーカスを閉じるボタンへ置く。見出しなどへ移すのは中身（呼び出し側）が決める
  // 620px 以下は引き出しがもともと全幅になり、真ん中の見た目が横と変わらないので、切り替えに真ん中を出さず、真ん中は横として描く
  let {
    labelledBy,
    busy = false,
    mode = 'side',
    onmode,
    onrequestclose,
    top,
    children,
  }: {
    // 見出しの文字を持つ要素の id（dialog の名前）
    labelledBy: string;
    busy?: boolean;
    mode?: TaskOpenMode;
    // 押した形と、今描いている形（狭い幅の真ん中は横）
    onmode: (mode: TaskOpenMode, shown: TaskOpenMode) => void;
    onrequestclose: () => void;
    // 上の帯の左（出どころの印など）
    top?: Snippet;
    children: Snippet;
  } = $props();

  let drawerElement = $state<HTMLElement>();
  let scrimElement = $state<HTMLElement>();
  let closeButton = $state<HTMLButtonElement>();

  const modeChoices = [
    { value: 'side', label: 'drawerSide' },
    { value: 'center', label: 'drawerCenter' },
    { value: 'page', label: 'drawerPage' },
    { value: 'tab', label: 'drawerTab' },
  ] as const satisfies readonly { value: TaskOpenMode; label: DictionaryKey }[];

  const narrow = new MediaQuery('max-width: 620px');
  const shownMode = $derived(effectiveTaskOpenMode(mode, narrow.current));
  const modal = $derived(shownMode === 'side' || shownMode === 'center');

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
    // ページ全体は外側も操作できる。メニューなど引き出しの外にフォーカスがあるときの Esc は、その操作のもの
    if (!modal && event.target !== document.body && !drawerElement?.contains(event.target as Node)) return;
    event.preventDefault();
    onrequestclose();
  }}
/>

<!-- 幕を押して閉じるのは、マウスと指のため。キーボードと読み上げには閉じるボタンと Esc がある -->
{#if modal}<div class="scrim" bind:this={scrimElement} aria-hidden="true" onclick={onrequestclose}></div>{/if}
<div
  class="drawer"
  class:is-center={shownMode === 'center'}
  class:is-page={!modal}
  bind:this={drawerElement}
  role={modal ? 'dialog' : 'region'}
  aria-modal={modal ? true : undefined}
  aria-labelledby={labelledBy}
  aria-busy={busy}
>
  <div class="drawer-top">
    {#if top}{@render top()}{/if}
    <span class="drawer-tools">
      <span class="drawer-mode" role="group" aria-label={t('drawerOpenMode')}>
        {#each modeChoices as choice (choice.value)}
          {#if choice.value !== 'center' || !narrow.current}
            <button
              class="pill"
              type="button"
              aria-pressed={shownMode === choice.value}
              onclick={() => onmode(choice.value, shownMode)}>{t(choice.label)}</button
            >
          {/if}
        {/each}
      </span>
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
