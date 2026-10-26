<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import DefinitionsSetting from '../../../../../lib/components/DefinitionsSetting.svelte';
  import EmptyState from '../../../../../lib/components/EmptyState.svelte';
  import LoadFailed from '../../../../../lib/components/LoadFailed.svelte';
  import PageHead from '../../../../../lib/components/PageHead.svelte';
  import { t } from '../../../../../lib/vocabulary.svelte.ts';
  import type { PageProps } from './$types';

  // ワークスペースの設定の画面（design/settings.html）。今あるのは区分とリポジトリの節で、ほかの節（一般、言葉づかい、列、決まった欄、
  // 完成の定義、換算比率、ワークスペースの休日）は、それぞれの Issue で .settings の中に足す。
  // 開けるのはリーダーと管理者だけ。一般のメンバーが URL で開いたら「入れない」の案内を出す（メニューにも出さない）。
  // 閉じたワークスペースでは、節を読み取り専用で出す（枠が読み取り専用の帯を出す）
  let { data }: PageProps = $props();

  const workspace = $derived(data.workspace);
  const definitions = $derived(data.definitions);
  const slug = $derived(page.params.slug ?? '');
  const canWrite = $derived(workspace !== null && workspace.closedAt === null);

  async function reload(): Promise<void> {
    await invalidate('app:workspace-settings');
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
  />
{:else if workspace && definitions === null}
  <LoadFailed inShell />
{:else if workspace && definitions !== null}
  <PageHead title={t('pageSettings')} eyebrow={workspace.name} />
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
