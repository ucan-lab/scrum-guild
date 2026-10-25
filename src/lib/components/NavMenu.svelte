<script lang="ts">
  import type { Snippet } from 'svelte';
  import { resolve } from '$app/paths';
  import { visibleNav } from '../nav.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // kit.js の navHtml。current は今の画面のパス。画面のある項目だけを出す（nav.ts の visibleNav）。
  // 組織とワークスペースの切り替えは置き場所だけで、中身は画面を作る Issue で snippet として渡す
  let {
    current,
    organizationSwitcher,
    workspaceSwitcher,
  }: { current: string; organizationSwitcher?: Snippet; workspaceSwitcher?: Snippet } = $props();

  const sections = visibleNav();
</script>

<nav class="nav">
  {#each sections as section (section.heading ?? section.slot)}
    {#if section.heading}<div class="nav-group">{t(section.heading)}</div>{/if}
    {#if section.slot === 'organization' && organizationSwitcher}{@render organizationSwitcher()}{/if}
    {#if section.slot === 'workspace' && workspaceSwitcher}{@render workspaceSwitcher()}{/if}
    {#each section.items as item (item.label)}
      {@const href = resolve(item.href)}
      <a class="nav-item" {href} aria-current={current === href ? 'page' : undefined}>
        <Icon name={item.icon} /><span>{t(item.label)}</span>
      </a>
    {/each}
  {/each}
</nav>
