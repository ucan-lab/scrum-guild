<script lang="ts">
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import Icon from '../../lib/components/Icon.svelte';
  import PageHead from '../../lib/components/PageHead.svelte';
  import Section from '../../lib/components/Section.svelte';
  import WorkspaceCreateDialog from '../../lib/components/WorkspaceCreateDialog.svelte';
  import { t } from '../../lib/vocabulary.svelte.ts';
  import type { PageProps } from './$types';

  // 今日やることの仮の画面。枠と見出しと空の状態を部品で組む。文言はすべて辞書を通す。
  // 今日やるタスクは API から取っていないので、件数や「所属すると並ぶ」といった事実は書かない。
  // 空の状態は管理者の場合を分ける。組織にワークスペースが1つも無いときは、最初のワークスペースを作る案内。
  // ワークスペースはあるが所属が0件のときは、所属が無いことの案内。最初のワークスペースを作る案内には、作るダイアログを開くボタンを置く
  let { data }: PageProps = $props();

  let createDialog = $state<ReturnType<typeof WorkspaceCreateDialog>>();

  const emptyKind = $derived.by(() => {
    const view = data.organization;
    if (view === null || !view.me.is_admin) return 'default';
    if (!view.organization.has_workspaces) return 'firstWorkspace';
    return view.workspaces.length === 0 ? 'noMembership' : 'default';
  });
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('pageToday'), app: t('appName') })}</title>
</svelte:head>

<PageHead title={t('pageToday')} />

<Section id="s-today" title={t('sectionToday')} hint={t('sectionTodayHint')}>
  {#if emptyKind === 'firstWorkspace'}
    <EmptyState
      icon="sun"
      art="map"
      title={t('firstWorkspaceTitle', { workspace: t('workspace') })}
      text={t('firstWorkspaceText', { workspace: t('workspace'), leader: t('leader') })}
    >
      {#snippet actions()}
        <button class="btn is-sm" type="button" onclick={(event) => createDialog?.show(event.currentTarget)}>
          <Icon name="plus" />{t('workspaceCreateAction', { workspace: t('workspace') })}
        </button>
      {/snippet}
    </EmptyState>
  {:else if emptyKind === 'noMembership'}
    <EmptyState
      icon="sun"
      art="notice"
      title={t('noMembershipTitle', { workspace: t('workspace') })}
      text={t('noMembershipText', { workspace: t('workspace') })}
    />
  {:else}
    <EmptyState icon="sun" art="notice" title={t('todayEmptyTitle')} text={t('todayEmptyText')} />
  {/if}
</Section>

{#if data.organization?.me.is_admin}
  <WorkspaceCreateDialog bind:this={createDialog} slug={data.slug} meId={data.organization.me.id} />
{/if}
