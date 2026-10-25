<script lang="ts">
  import { resolve } from '$app/paths';
  import EmptyState from '../../../lib/components/EmptyState.svelte';
  import Icon from '../../../lib/components/Icon.svelte';
  import LoadFailed from '../../../lib/components/LoadFailed.svelte';
  import NotFoundPage from '../../../lib/components/NotFoundPage.svelte';
  import PageHead from '../../../lib/components/PageHead.svelte';
  import Setting from '../../../lib/components/Setting.svelte';
  import WorkspaceCreateDialog from '../../../lib/components/WorkspaceCreateDialog.svelte';
  import { formatLocalDate } from '../../../lib/format.ts';
  import { t } from '../../../lib/vocabulary.svelte.ts';
  import type { PageProps } from './$types';

  // 組織の管理の画面（admin.html）。今はワークスペースの節だけ。ほかの節は、それぞれの Issue で足す。
  // 管理者でなければ「見つからない」と同じ扱い。「閉じる」と「開き直す」のボタンは、閉じる Issue で足す
  let { data }: PageProps = $props();

  const organization = $derived(data.organization);
  const workspaces = $derived(data.workspaces);
  let createDialog = $state<ReturnType<typeof WorkspaceCreateDialog>>();

  const openCount = $derived(workspaces?.filter((workspace) => workspace.closed_at === null).length ?? 0);
</script>

<!-- 見つからない画面と読み込みの失敗は、それぞれの題名を持つ -->
<svelte:head>
  {#if !data.forbidden && organization !== null && workspaces !== null}
    <title>{t('pageTitle', { page: t('pageOrgAdmin'), app: t('appName') })}</title>
  {/if}
</svelte:head>

{#if data.forbidden || organization === null}
  <NotFoundPage slug={data.slug} title={t('pageNotFoundTitle')} text={t('pageNotFoundText')} />
{:else if workspaces === null}
  <LoadFailed inShell />
{:else}
  <PageHead
    eyebrow={t('adminEyebrow', { admin: t('admin') })}
    title={t('pageOrgAdmin')}
    tallies={[{ label: t('workspaceOpenLabel', { workspace: t('workspace') }), count: openCount }]}
  >
    {#snippet actions()}
      <button class="btn is-primary" type="button" onclick={(event) => createDialog?.show(event.currentTarget)}>
        <Icon name="plus" />{t('workspaceCreateAction', { workspace: t('workspace') })}
      </button>
    {/snippet}
  </PageHead>

  <div class="settings">
    <Setting
      title={t('workspace')}
      description={t('adminWorkspacesDesc', { workspace: t('workspace'), member: t('member'), leader: t('leader') })}
    >
      {#if workspaces.length === 0}
        <EmptyState
          icon="users"
          title={t('firstWorkspaceTitle', { workspace: t('workspace') })}
          text={t('workspaceEmptyText', { workspace: t('workspace'), leader: t('leader'), member: t('member') })}
        >
          {#snippet actions()}
            <button class="btn is-sm" type="button" onclick={(event) => createDialog?.show(event.currentTarget)}>
              <Icon name="plus" />{t('workspaceCreateAction', { workspace: t('workspace') })}
            </button>
          {/snippet}
        </EmptyState>
      {:else}
        <div class="table-wrap">
          <table class="table" aria-label={t('workspaceListLabel', { workspace: t('workspace') })}>
            <thead>
              <tr>
                <th>{t('fieldName')}</th>
                <th class="is-num">{t('member')}</th>
                <th class="is-num">{t('leader')}</th>
                <th>{t('createdOn')}</th>
              </tr>
            </thead>
            <tbody>
              {#each workspaces as workspace (workspace.id)}
                <tr>
                  <td>
                    <a href={resolve('/[slug]/w/[id]', { slug: data.slug, id: workspace.id })}>{workspace.name}</a>
                    {#if workspace.closed_at !== null}
                      <span class="chip"
                        >{t('workspaceClosedChip', { date: formatLocalDate(workspace.closed_at) })}</span
                      >
                    {:else if workspace.leader_count === 0}
                      <span class="chip is-warn">{t('workspaceNoLeaderChip', { leader: t('leader') })}</span>
                    {/if}
                  </td>
                  <td class="is-num">{workspace.member_count}</td>
                  <td class="is-num">{workspace.leader_count}</td>
                  <td class="mono">{workspace.created_on}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </Setting>
  </div>

  <WorkspaceCreateDialog
    bind:this={createDialog}
    slug={data.slug}
    meId={organization.me.id}
    organizationVocabulary={organization.organization.vocabulary}
  />
{/if}
