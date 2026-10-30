<script lang="ts">
  import type { Snippet } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { effectiveTaskOpenMode, type TaskOpenMode } from '../drawer.svelte.ts';
  import { inertOutside } from '../inert-outside.ts';
  import { modalState } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // 横と真ん中はモーダル。ページ全体は通常の画面として同じ中身を出す。
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
    onmode: (mode: TaskOpenMode) => void;
    onrequestclose: () => void;
    // 上の帯の左（出どころの印など）
    top?: Snippet;
    children: Snippet;
  } = $props();

  let drawerElement = $state<HTMLElement>();
  let scrimElement = $state<HTMLElement>();
  let closeButton = $state<HTMLButtonElement>();

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
      <label class="drawer-mode">
        <span class="visually-hidden">{t('drawerOpenMode')}</span>
        <select
          class="select"
          value={shownMode}
          onchange={(event) => {
            const next = event.currentTarget.value as TaskOpenMode;
            event.currentTarget.value = shownMode;
            onmode(next);
          }}
        >
          <option value="side">{t('drawerSide')}</option>
          {#if !narrow.current}<option value="center">{t('drawerCenter')}</option>{/if}
          <option value="page">{t('drawerPage')}</option>
          <option value="tab">{t('drawerTab')}</option>
        </select>
      </label>
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
