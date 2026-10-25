<script lang="ts">
  import type { Snippet } from 'svelte';
  import { resolve } from '$app/paths';
  import { t } from '../vocabulary.svelte.ts';
  import NavMenu from './NavMenu.svelte';

  // kit.js の mount が組む画面の枠。左のメニュー（綴じ）と、上の帯と本文（帳面）。
  // 組織とワークスペースの切り替え、アシスタントのボタンは置き場所だけで、中身は snippet で渡す。
  // 上の帯は、assistant、tools、account のどれかを渡したときだけ出す（空の帯を出さない）。
  // tools は開発用の切り替えなど、account はログインしている人の表示
  let {
    current,
    organizationSwitcher,
    workspaceSwitcher,
    assistant,
    tools,
    account,
    children,
  }: {
    current: string;
    organizationSwitcher?: Snippet;
    workspaceSwitcher?: Snippet;
    assistant?: Snippet;
    tools?: Snippet;
    account?: Snippet;
    children: Snippet;
  } = $props();
</script>

<div class="app">
  <aside class="binding" aria-label={t('menu')}>
    <div class="binding-inner">
      <a class="brand" href={resolve('/')}>
        <span class="brand-seal" aria-hidden="true"
          ><span class="orn-medieval">冒</span><span class="orn-plain">SG</span></span
        >
        <span class="brand-name">{t('appName')}</span>
      </a>
      <NavMenu {current} {organizationSwitcher} {workspaceSwitcher} />
    </div>
  </aside>
  <div class="sheet">
    {#if assistant || tools || account}
      <div class="topbar">
        {#if assistant}{@render assistant()}{/if}
        {#if tools}{@render tools()}{/if}
        {#if account}{@render account()}{/if}
      </div>
    {/if}
    <main class="content" id="content">{@render children()}</main>
  </div>
</div>
