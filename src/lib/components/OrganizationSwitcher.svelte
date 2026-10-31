<script lang="ts">
  import { navigating } from '$app/state';
  import { resolve } from '$app/paths';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // kit.js の orgMenuHtml。開閉するメニューで、中は各組織へのリンクと、最後に組織の選択の画面（/）へ戻るリンク。
  // 選ぶと画面が移るので select にしない（矢印キーで選んだだけで移ってしまう）。
  // 閉じるのは、ボタン、メニューの外を押す、Tab でメニューの外へ出る、リンクを押す、Esc。
  // メニューの中にフォーカスがあるときに閉じたら、ボタンへフォーカスを戻す（隠れた要素にフォーカスを残さない）。
  // 今の組織の名前は、入れる組織の一覧の中の名前を使う。一覧に無いとき（取れなかった）だけ fallbackName を使う。
  // invited は、届いた招待があること。招待が見える入口は組織の選択の画面だけなので、ここで印を出す
  let {
    organizations,
    currentSlug,
    fallbackName,
    invited,
  }: {
    organizations: readonly { slug: string; name: string }[];
    currentSlug: string;
    fallbackName: string;
    invited: boolean;
  } = $props();

  const listId = $props.id();
  let open = $state(false);
  let root = $state<HTMLElement>();
  let button = $state<HTMLButtonElement>();

  const currentName = $derived(organizations.find((item) => item.slug === currentSlug)?.name ?? fallbackName);
  // 今の組織から離れる移動（別の組織、組織の選択の画面）の最中
  const moving = $derived(
    navigating.to !== null && (navigating.to.route.id === '/' || navigating.to.params?.slug !== currentSlug),
  );
  // 名前の欄と、畳んだ列の札に出す文字。移っている最中はどちらも「移っています」
  const shownName = $derived(moving ? t('organizationMoving') : currentName);
  const label = $derived(
    t('organizationSwitchLabel', { name: currentName }) + (invited ? `。${t('invitationsBadge')}` : ''),
  );

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

<div class="org-menu" bind:this={root} onfocusout={onFocusout}>
  <button
    class="org-menu-button"
    type="button"
    aria-expanded={open}
    aria-controls={listId}
    aria-label={label}
    data-moving={moving ? 'true' : undefined}
    bind:this={button}
    onclick={() => (open = !open)}
  >
    <span class="org-menu-label">{t('organization')}</span>
    <b>{shownName}</b>
    {#if invited}<span class="chip">{t('invitationsBadge')}</span>{/if}
    {#if invited}<span class="org-menu-invite" aria-hidden="true"></span>{/if}
    <Icon name="swap" />
    <Icon name="chevron" />
    <!-- 畳んだ列で、ホバーとキーボードのフォーカスのときに今の組織と招待の有無を目で読ませる札。読み上げは aria-label が受け持つ。
         移っている最中は、広げた列の名前の欄と同じく「移っています」を出し、畳んだ列では札を出したままにする（押し直しを誘わない） -->
    <span class="nav-tip" aria-hidden="true"
      >{shownName}{#if invited && !moving}<small>{t('invitationsBadge')}</small>{/if}</span
    >
  </button>
  <!-- 移っている最中を読み上げに伝える。領域は常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{moving ? t('organizationMoving') : ''}</span>
  <ul class="org-menu-list" id={listId} aria-label={t('organizationListLabel')} hidden={!open}>
    {#each organizations as organization (organization.slug)}
      {@const current = organization.slug === currentSlug}
      <li>
        <a
          href={resolve('/[slug]', { slug: organization.slug })}
          aria-current={current ? 'page' : undefined}
          onclick={closeMenu}
        >
          <span class="org-menu-name">{organization.name}</span>
          {#if current}<Icon name="check" />{/if}
        </a>
      </li>
    {/each}
    <li>
      <a href={resolve('/')} onclick={closeMenu}>
        <span class="org-menu-name">{t('organizationList')}</span>
        {#if invited}<span class="org-menu-note">{t('invitationsReceived')}</span>{/if}
      </a>
    </li>
  </ul>
</div>
