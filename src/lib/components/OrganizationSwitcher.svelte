<script lang="ts">
  import { resolve } from '$app/paths';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // kit.js の orgMenuHtml。開閉するメニューで、中は各組織へのリンクと、最後に組織の選択の画面（/）へ戻るリンク。
  // 選ぶと画面が移るので select にしない（矢印キーで選んだだけで移ってしまう）。
  // メニューの外を押す、Esc、リンクを押すと閉じる。Esc で閉じたら開いたボタンにフォーカスを戻す
  let {
    organizations,
    currentSlug,
    currentName,
  }: { organizations: readonly { slug: string; name: string }[]; currentSlug: string; currentName: string } = $props();

  const listId = $props.id();
  let open = $state(false);
  let root = $state<HTMLElement>();
  let button = $state<HTMLButtonElement>();

  function close(): void {
    open = false;
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!open || event.key !== 'Escape') return;
    open = false;
    button?.focus();
  }

  function onClick(event: MouseEvent): void {
    if (open && root && event.target instanceof Node && !root.contains(event.target)) open = false;
  }
</script>

<svelte:window onkeydown={onKeydown} onclick={onClick} />

<div class="org-menu" bind:this={root}>
  <button
    class="org-menu-button"
    type="button"
    aria-expanded={open}
    aria-controls={listId}
    bind:this={button}
    onclick={() => (open = !open)}
  >
    <span>{t('organization')}</span>
    <b>{currentName}</b>
    <Icon name="chevron" />
  </button>
  <ul class="org-menu-list" id={listId} hidden={!open}>
    {#each organizations as organization (organization.slug)}
      <li>
        <a
          href={resolve('/[slug]', { slug: organization.slug })}
          aria-current={organization.slug === currentSlug ? 'true' : undefined}
          onclick={close}>{organization.name}</a
        >
      </li>
    {/each}
    <li><a href={resolve('/')} onclick={close}>{t('organizationList')}</a></li>
  </ul>
</div>
