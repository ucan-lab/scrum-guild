<script lang="ts">
  import { navigating } from '$app/state';
  import { resolve } from '$app/paths';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';
  import { SwitcherMenu } from './switcher-menu.svelte.ts';

  // kit.js の orgMenuHtml。開閉するメニューで、中は各組織へのリンクと、最後に組織の選択の画面（/）へ戻るリンク。
  // 選ぶと画面が移るので select にしない（矢印キーで選んだだけで移ってしまう）。
  // 閉じるのは、ボタン、メニューの外を押す、Tab でメニューの外へ出る、リンクを押す、Esc。
  // メニューの中にフォーカスがあるときに閉じたら、ボタンへフォーカスを戻す（隠れた要素にフォーカスを残さない）。
  // 今の組織の名前は、入れる組織の一覧の中の名前を使う。一覧に無いとき（取れなかった）だけ fallbackName を使う。
  // invited は、届いた招待があること。招待が見える入口は組織の選択の画面だけなので、ここで印を出す。
  // 最後に「組織を作る」を置く。入れる組織が1つで招待が無い人は / を開くとその組織へ移り、組織の選択の画面の「組織を作る」に届かないので、
  // ここが入口になる。押すとメニューを閉じてから oncreate に押したボタンを渡す（ダイアログは、メニューを閉じても残る枠の側が持つ。
  // フォーカスは、閉じたメニューのボタンへ戻る）。
  // 「組織の一覧へ」は、/ が今の組織へ戻すだけのとき（入れる組織が1つで招待が無い）は出さない（landingFor と同じ条件）
  let {
    organizations,
    currentSlug,
    fallbackName,
    invited,
    oncreate,
  }: {
    organizations: readonly { slug: string; name: string }[];
    currentSlug: string;
    fallbackName: string;
    invited: boolean;
    oncreate: (trigger: HTMLElement | null) => void;
  } = $props();

  const listId = $props.id();
  const menu = new SwitcherMenu();

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

  const hasList = $derived(organizations.length > 1 || invited);

  function create(): void {
    menu.close();
    oncreate(menu.button ?? null);
  }
</script>

<svelte:window onkeydown={menu.onkeydown} onclick={menu.onclick} />

<div class="org-menu" bind:this={menu.root} onfocusout={menu.onfocusout}>
  <button
    class="org-menu-button"
    type="button"
    aria-expanded={menu.open}
    aria-controls={listId}
    aria-label={label}
    data-moving={moving ? 'true' : undefined}
    bind:this={menu.button}
    onclick={menu.toggle}
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
  <ul class="org-menu-list" id={listId} aria-label={t('organizationListLabel')} hidden={!menu.open}>
    {#each organizations as organization (organization.slug)}
      {@const current = organization.slug === currentSlug}
      <li>
        <a
          href={resolve('/[slug]', { slug: organization.slug })}
          aria-current={current ? 'page' : undefined}
          onclick={menu.close}
        >
          <span class="org-menu-name">{organization.name}</span>
          {#if current}<Icon name="check" />{/if}
        </a>
      </li>
    {/each}
    {#if hasList}
      <li class="is-aside">
        <a href={resolve('/')} onclick={menu.close}>
          <span class="org-menu-name">{t('organizationList')}</span>
          {#if invited}<span class="org-menu-note">{t('invitationsReceived')}</span>{/if}
        </a>
      </li>
    {/if}
    <li class="is-aside">
      <button type="button" onclick={create}>
        <span class="org-menu-name">{t('createMyOrganizationAction')}</span>
      </button>
    </li>
  </ul>
</div>
