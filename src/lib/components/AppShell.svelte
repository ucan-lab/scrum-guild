<script lang="ts">
  import type { Snippet } from 'svelte';
  import { resolve } from '$app/paths';
  import { t } from '../vocabulary.svelte.ts';
  import BrandMark from './BrandMark.svelte';
  import NavMenu from './NavMenu.svelte';

  // kit.js の mount が組む画面の枠。左のメニュー（綴じ）と、上の帯と本文（帳面）。slug は今の組織で、組織の中の画面だけが使う。
  // 組織の切り替え（ブランドの下）、ワークスペースの切り替え、アシスタントのボタンは置き場所だけで、中身は snippet で渡す。
  // workspaceSwitcher を渡すのは、ワークスペースの画面を開いている間（メニューにワークスペースの節を出す）。
  // 上の帯は、assistant か account のどちらかを渡したときだけ出す（空の帯を出さない）。account はログインしている人の表示
  let {
    current,
    slug,
    hasWorkspace,
    isAdmin,
    organizationSwitcher,
    workspaceSwitcher,
    assistant,
    account,
    children,
  }: {
    current: string;
    slug: string;
    hasWorkspace: boolean;
    isAdmin: boolean;
    organizationSwitcher?: Snippet;
    workspaceSwitcher?: Snippet;
    assistant?: Snippet;
    account?: Snippet;
    children: Snippet;
  } = $props();
</script>

<div class="app">
  <aside class="binding" aria-label={t('menu')}>
    <div class="binding-inner">
      <a class="brand" href={resolve('/[slug]', { slug })}>
        <BrandMark />
        <span class="brand-name">{t('appName')}</span>
      </a>
      {#if organizationSwitcher}{@render organizationSwitcher()}{/if}
      <NavMenu {current} {slug} {hasWorkspace} {isAdmin} {workspaceSwitcher} />
    </div>
  </aside>
  <div class="sheet">
    {#if assistant || account}
      <div class="topbar">
        {#if assistant}{@render assistant()}{/if}
        {#if account}{@render account()}{/if}
      </div>
    {/if}
    <main class="content" id="content">{@render children()}</main>
  </div>
</div>
