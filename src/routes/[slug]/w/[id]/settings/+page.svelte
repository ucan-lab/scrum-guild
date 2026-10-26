<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import DefinitionsSetting from '../../../../../lib/components/DefinitionsSetting.svelte';
  import EmptyState from '../../../../../lib/components/EmptyState.svelte';
  import Icon from '../../../../../lib/components/Icon.svelte';
  import LoadFailed from '../../../../../lib/components/LoadFailed.svelte';
  import PageHead from '../../../../../lib/components/PageHead.svelte';
  import { t } from '../../../../../lib/vocabulary.svelte.ts';
  import type { PageProps } from './$types';

  // ワークスペースの設定の画面（design/settings.html）。今あるのは区分とリポジトリの節で、ほかの節（一般、言葉づかい、列、決まった欄、
  // 完成の定義、換算比率、ワークスペースの休日）は、それぞれの Issue で .settings の中に足す。
  // 開けるのはリーダーと管理者だけ。一般のメンバーが URL で開いたら「入れない」の案内と、バックログへ戻るリンクを出す（メニューにも出さない）。
  // 閉じたワークスペースでは、節を読み取り専用で出す（枠が読み取り専用の帯を出す）。
  // 最初の読み込みの失敗は画面全体を LoadFailed にする。書いた後の読み直しが失敗したときは、前に読めた一覧を残したまま、
  // 節の先頭に「一覧を更新できませんでした」と「もう一度試す」を出す（組織の管理の画面の SectionBoundary と同じ扱い）
  let { data }: PageProps = $props();

  type Definitions = NonNullable<typeof data.definitions>;

  const workspace = $derived(data.workspace);
  const slug = $derived(page.params.slug ?? '');
  const canWrite = $derived(workspace !== null && workspace.closedAt === null);

  // 前に読めた一覧と、読み直しに失敗したか。ワークスペースが替わったら捨てる
  let kept = $state<{ workspaceId: string; definitions: Definitions } | null>(null);
  let refreshFailed = $state(false);
  let retrying = $state(false);
  let retryFailed = $state(false);
  $effect.pre(() => {
    const id = workspace?.id ?? null;
    if (data.definitions !== null && id !== null) {
      kept = { workspaceId: id, definitions: data.definitions };
      refreshFailed = false;
    } else if (kept !== null && kept.workspaceId !== id) {
      kept = null;
    }
  });
  const definitions = $derived(
    data.definitions ?? (kept !== null && kept.workspaceId === workspace?.id ? kept.definitions : null),
  );

  async function reload(): Promise<void> {
    await invalidate('app:workspace-settings');
    refreshFailed = data.definitions === null && kept !== null;
  }

  async function retry(): Promise<void> {
    if (retrying) return;
    retrying = true;
    retryFailed = false;
    try {
      await reload();
      retryFailed = refreshFailed;
    } finally {
      retrying = false;
    }
  }

  function stale(): void {
    void invalidate('app:workspace');
  }
</script>

<svelte:head>
  {#if workspace}
    <title>
      {t('pageTitle', {
        page: t('settingsPageName', { settings: t('pageSettings'), name: workspace.name }),
        app: t('appName'),
      })}
    </title>
  {/if}
</svelte:head>

{#if workspace && data.forbidden}
  <PageHead title={t('pageSettings')} eyebrow={workspace.name} />
  <EmptyState
    icon="lock"
    title={t('settingsForbiddenTitle')}
    text={t('settingsForbiddenText', { settings: t('pageSettings'), leader: t('leader'), admin: t('admin') })}
  >
    {#snippet actions()}
      <a class="btn is-sm" href={resolve('/[slug]/w/[id]', { slug, id: workspace.id })}
        >{t('settingsBackToBacklog', { backlog: t('backlog') })}</a
      >
    {/snippet}
  </EmptyState>
{:else if workspace && definitions === null}
  <LoadFailed inShell />
{:else if workspace && definitions !== null}
  <PageHead title={t('pageSettings')} eyebrow={workspace.name} />
  {#if refreshFailed}
    <div class="callout is-warn">
      <Icon name="alert" /><span role="alert">{t('settingsRefreshFailed')}</span>
      <div class="callout-actions">
        <button class="btn is-sm" type="button" aria-disabled={retrying} onclick={() => void retry()}
          >{t('retry')}</button
        >
        <span class="field-hint" role="status">{retrying ? t('retrying') : retryFailed ? t('retryFailed') : ''}</span>
      </div>
    </div>
  {/if}
  <div class="settings">
    {#key workspace.id}
      <DefinitionsSetting
        kind="category"
        {slug}
        workspaceId={workspace.id}
        items={definitions.categories}
        {canWrite}
        onchanged={reload}
        onstale={stale}
      />
      <DefinitionsSetting
        kind="repository"
        {slug}
        workspaceId={workspace.id}
        items={definitions.repositories}
        {canWrite}
        onchanged={reload}
        onstale={stale}
      />
    {/key}
  </div>
{/if}
