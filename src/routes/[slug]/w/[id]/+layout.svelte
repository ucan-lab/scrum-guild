<script lang="ts">
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import LoadFailed from '../../../../lib/components/LoadFailed.svelte';
  import NotFoundPage from '../../../../lib/components/NotFoundPage.svelte';
  import { setWorkspaceVocabulary, t } from '../../../../lib/vocabulary.svelte.ts';
  import type { LayoutData } from './$types';

  // ワークスペースの枠。workspace の操作の結果で、ワークスペースの中の言葉づかいを当てる（離れるときに戻す）。
  // 左のメニューのワークスペースの節と、上の帯の「所属せず管理者として開いています」の印は、組織の枠が page.data から出す。
  // 存在しない ID と別の組織の ID は、どちらも同じ「見つからない」。ほかの失敗（通信、5xx、権限）は読み込みの失敗
  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  const workspace = $derived(data.workspace);
  const notFound = $derived(data.workspaceFailure?.status === 404 && data.workspaceFailure.code === 'not_found');

  $effect(() => {
    if (!workspace) return;
    setWorkspaceVocabulary(workspace.vocabulary);
    return () => setWorkspaceVocabulary(null);
  });
</script>

{#if workspace}
  {@render children()}
{:else if notFound}
  <NotFoundPage
    slug={page.params.slug ?? ''}
    title={t('workspaceNotFoundTitle', { workspace: t('workspace') })}
    text={t('workspaceNotFoundText', { workspace: t('workspace') })}
  />
{:else}
  <LoadFailed inShell />
{/if}
