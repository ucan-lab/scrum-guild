<script lang="ts">
  import type { Snippet } from 'svelte';
  import { resolve } from '$app/paths';
  import { isWorkspaceRoute, visibleNav } from '../nav.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // kit.js の navHtml。current は今の画面のパス、slug は今の組織。画面のある項目だけを出す（nav.ts の visibleNav）。
  // 組織の管理は管理者にだけ出す。所属するワークスペースが無い人（hasWorkspace が偽）には、組織の画面だけを出す。
  // workspaceSwitcher を渡すのは、ワークスペースの画面を開いている間。所属していない管理者にも、
  // ワークスペースの節の見出しと、今のワークスペースを出す。ワークスペースの切り替えの中身は、画面を作る Issue で足す。
  // ワークスペースの経路の項目（メンバーなど）は、workspaceId を渡したときだけ出す。渡すのは、開いているワークスペースの ID。
  // 組織の切り替えはメニューの外（AppShell のブランドの下）に置く
  let {
    current,
    slug,
    hasWorkspace,
    isAdmin,
    workspaceId,
    workspaceSwitcher,
  }: {
    current: string;
    slug: string;
    hasWorkspace: boolean;
    isAdmin: boolean;
    workspaceId?: string;
    workspaceSwitcher?: Snippet;
  } = $props();

  const sections = $derived(
    visibleNav(undefined, {
      hasWorkspace,
      isAdmin,
      inWorkspaceScreen: workspaceSwitcher !== undefined,
      workspaceId: workspaceId ?? null,
    }),
  );
</script>

<nav class="nav">
  {#each sections as section (section.heading ?? 'organization')}
    {#if section.heading}<div class="nav-group">{t(section.heading)}</div>{/if}
    {#if section.slot === 'workspace' && workspaceSwitcher}{@render workspaceSwitcher()}{/if}
    {#each section.items as item (item.label)}
      <!-- ワークスペースの経路は、ID が無ければ行き先が決まらないので描かない（visibleNav も同じ条件で外す） -->
      {@const href = isWorkspaceRoute(item.href)
        ? workspaceId
          ? resolve(item.href, { slug, id: workspaceId })
          : null
        : resolve(item.href, { slug })}
      {#if href !== null}
        <a class="nav-item" {href} aria-current={current === href ? 'page' : undefined}>
          <Icon name={item.icon} /><span>{t(item.label)}</span>
        </a>
      {/if}
    {/each}
  {/each}
</nav>
