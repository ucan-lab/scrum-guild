<script lang="ts">
  import { logoutState, performLogout } from '../logout-action.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';

  // kit.js の accountMenuHtml。上の帯の自分の名前を押すと開くメニューで、中は「ログアウト」の1項目（後で「自分の設定」も入る）。
  // 開閉は OrganizationSwitcher と同じ: ボタン、メニューの外を押す、Tab でメニューの外へ出る、Esc。
  // メニューの中にフォーカスがあるときに閉じたら、ボタンへフォーカスを戻す（隠れた要素にフォーカスを残さない）。
  // ログアウトを押しても閉じない。結果が返るまで項目を止めて「ログアウトしています」を見せ、失敗したら項目を戻す
  let { userId, name, isAdmin }: { userId: string; name: string; isAdmin: boolean } = $props();

  const listId = $props.id();
  let open = $state(false);
  let root = $state<HTMLElement>();
  let button = $state<HTMLButtonElement>();

  function closeMenu(): void {
    // 隠れる要素にフォーカスがあるなら、ボタンへ戻す
    if (root?.contains(document.activeElement)) button?.focus();
    open = false;
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!open || event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
    event.stopPropagation();
    closeMenu();
  }

  function onClick(event: MouseEvent): void {
    if (open && root && event.target instanceof Node && !root.contains(event.target)) closeMenu();
  }

  // Tab などで、フォーカスがメニューの外へ出たら閉じる（出た先へ移ったので、戻さない）
  function onFocusout(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (open && root && next instanceof Node && !root.contains(next)) open = false;
  }
</script>

<svelte:window onkeydown={onKeydown} onclick={onClick} />

<div class="account-menu" bind:this={root} onfocusout={onFocusout}>
  <button
    class="account-menu-button"
    type="button"
    aria-expanded={open}
    aria-controls={listId}
    aria-label={t('accountMenuLabel', { name })}
    bind:this={button}
    onclick={() => (open = !open)}
  >
    <span class="me">
      <Avatar {userId} {name} />{name}
      {#if isAdmin}<span class="chip">{t('admin')}</span>{/if}
    </span>
    <Icon name="chevron" />
  </button>
  <ul class="account-menu-list" id={listId} aria-label={t('accountMenuLabel', { name })} hidden={!open}>
    <li>
      <button type="button" aria-disabled={logoutState.busy} onclick={performLogout}>
        <span class="org-menu-name">{logoutState.busy ? t('logoutMoving') : t('logout')}</span>
      </button>
    </li>
  </ul>
</div>
