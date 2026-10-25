<script lang="ts">
  import type { Snippet } from 'svelte';
  import { resolve } from '$app/paths';
  import { navSections } from '../nav.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // kit.js の navHtml。current は今の画面のパス。
  // 組織とワークスペースの切り替えは置き場所だけで、中身は画面を作る Issue で snippet として渡す
  let {
    current,
    organizationSwitcher,
    workspaceSwitcher,
  }: { current: string; organizationSwitcher?: Snippet; workspaceSwitcher?: Snippet } = $props();
</script>

<nav class="nav">
  {#each navSections as section (section.heading ?? section.slot)}
    {#if section.heading}<div class="nav-group">{t(section.heading)}</div>{/if}
    {#if section.slot === 'organization' && organizationSwitcher}{@render organizationSwitcher()}{/if}
    {#if section.slot === 'workspace' && workspaceSwitcher}{@render workspaceSwitcher()}{/if}
    {#each section.items as item (item.label)}
      {#if item.href}
        {@const href = resolve(item.href)}
        <a class="nav-item" {href} aria-current={current === href ? 'page' : undefined}>
          <Icon name={item.icon} /><span>{t(item.label)}</span>
        </a>
      {:else}
        <span class="nav-item is-later"><Icon name={item.icon} /><span>{t(item.label)}</span></span>
      {/if}
    {/each}
  {/each}
</nav>
