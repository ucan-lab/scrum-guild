<script lang="ts">
  import EmptyState from '../../../../lib/components/EmptyState.svelte';
  import PageHead from '../../../../lib/components/PageHead.svelte';
  import { formatLocalDate } from '../../../../lib/format.ts';
  import { t } from '../../../../lib/vocabulary.svelte.ts';
  import type { PageProps } from './$types';

  // ワークスペースの画面。中身はまだ無い（バックログなどは、それぞれの画面の Issue で足す）。
  // 見出しはワークスペースの名前。閉じていれば、閉じた日を印で出す
  let { data }: PageProps = $props();

  const workspace = $derived(data.workspace);
</script>

<svelte:head>
  {#if workspace}
    <title>{t('pageTitle', { page: workspace.name, app: t('appName') })}</title>
  {/if}
</svelte:head>

{#if workspace}
  <PageHead title={workspace.name} focusable>
    {#snippet actions()}
      {#if workspace.closedAt}
        <span class="chip">{t('workspaceClosedChip', { date: formatLocalDate(workspace.closedAt) })}</span>
      {/if}
    {/snippet}
  </PageHead>

  <EmptyState
    icon="board"
    title={t('workspaceHomeEmptyTitle', { workspace: t('workspace') })}
    text={t('workspaceHomeEmptyText', { backlog: t('backlog') })}
  />
{/if}
