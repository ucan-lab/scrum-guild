<script lang="ts">
  import type { Snippet } from 'svelte';
  import { resolve } from '$app/paths';
  import { visibleNav } from '../nav.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // kit.js の navHtml。current は今の画面のパス、slug は今の組織。画面のある項目だけを出す（nav.ts の visibleNav）。
  // 所属するワークスペースが無い人（hasWorkspace が偽）には、組織の画面だけを出す。
  // ワークスペースの切り替えは置き場所だけで、中身は画面を作る Issue で snippet として渡す。
  // 組織の切り替えはメニューの外（AppShell のブランドの下）に置く
  let {
    current,
    slug,
    hasWorkspace,
    workspaceSwitcher,
  }: {
    current: string;
    slug: string;
    hasWorkspace: boolean;
    workspaceSwitcher?: Snippet;
  } = $props();

  const sections = $derived(visibleNav(undefined, { hasWorkspace }));
</script>

<nav class="nav">
  {#each sections as section (section.heading ?? 'organization')}
    {#if section.heading}<div class="nav-group">{t(section.heading)}</div>{/if}
    {#if section.slot === 'workspace' && workspaceSwitcher}{@render workspaceSwitcher()}{/if}
    {#each section.items as item (item.label)}
      {@const href = resolve(item.href, { slug })}
      <a class="nav-item" {href} aria-current={current === href ? 'page' : undefined}>
        <Icon name={item.icon} /><span>{t(item.label)}</span>
      </a>
    {/each}
  {/each}
</nav>
