<script lang="ts">
  import { resolve } from '$app/paths';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';
  import { SwitcherMenu } from './switcher-menu.svelte.ts';

  let {
    workspaces,
    currentWorkspace,
    slug,
  }: {
    workspaces: readonly { id: string; name: string }[];
    currentWorkspace: { id: string; name: string };
    slug: string;
  } = $props();

  const listId = $props.id();
  const menu = new SwitcherMenu();
  const currentName = $derived(
    workspaces.find((workspace) => workspace.id === currentWorkspace.id)?.name ?? currentWorkspace.name,
  );
  const isMember = $derived(workspaces.some((workspace) => workspace.id === currentWorkspace.id));
</script>

<svelte:window onkeydown={menu.onkeydown} onclick={menu.onclick} />

<div class="ws-menu" bind:this={menu.root} onfocusout={menu.onfocusout}>
  <button
    class="ws-menu-button"
    type="button"
    aria-expanded={menu.open}
    aria-controls={listId}
    aria-label={t('workspaceSwitchLabel', { name: currentName, workspace: t('workspace') })}
    bind:this={menu.button}
    onclick={menu.toggle}
  >
    <span class="ws-menu-label">{t('workspace')}</span>
    <b>{currentName}</b>
    <Icon name="chevron" />
  </button>
  <ul
    class="ws-menu-list"
    id={listId}
    aria-label={t('workspaceSwitchListLabel', { workspace: t('workspace') })}
    hidden={!menu.open}
  >
    {#if !isMember}
      <!-- 所属していない管理者が見ているものは、移動先の所属一覧に加えず、名前だけ先頭に出す。 -->
      <li class="ws-menu-current"><span aria-current="page">{currentWorkspace.name}</span></li>
    {/if}
    {#each workspaces as workspace (workspace.id)}
      {@const current = workspace.id === currentWorkspace.id}
      <li>
        <a
          href={resolve('/[slug]/w/[id]', { slug, id: workspace.id })}
          aria-current={current ? 'page' : undefined}
          onclick={menu.close}
        >
          <span class="org-menu-name">{workspace.name}</span>
          {#if current}<Icon name="check" />{/if}
        </a>
      </li>
    {/each}
  </ul>
</div>
