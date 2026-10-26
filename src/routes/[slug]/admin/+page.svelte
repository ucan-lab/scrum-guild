<script lang="ts">
  import Icon from '../../../lib/components/Icon.svelte';
  import NotFoundPage from '../../../lib/components/NotFoundPage.svelte';
  import PageHead from '../../../lib/components/PageHead.svelte';
  import WorkspacesSetting from '../../../lib/components/admin/WorkspacesSetting.svelte';
  import HolidaysSetting from '../../../lib/components/admin/HolidaysSetting.svelte';
  import OrganizationLookSetting from '../../../lib/components/admin/OrganizationLookSetting.svelte';
  import HistorySetting from '../../../lib/components/admin/HistorySetting.svelte';
  import { t } from '../../../lib/vocabulary.svelte.ts';
  import type { PageProps } from './$types';

  // 組織の管理の画面（admin.html）。節は src/lib/components/admin/ の部品で、それぞれ自分でデータを読む。
  // ほかの節（ユーザー）は、部品を足してここに並べる。
  // 管理者でなければ「見つからない」と同じ扱い
  let { data }: PageProps = $props();

  const organization = $derived(data.organization);
  let workspacesSetting = $state<ReturnType<typeof WorkspacesSetting>>();
  // ワークスペースの節が読んだ、開いているワークスペースの数。読めるまでは null で、集計を出さない
  let openCount = $state<number | null>(null);
</script>

<!-- 見つからない画面は、その題名を持つ -->
<svelte:head>
  {#if !data.forbidden && organization !== null}
    <title>{t('pageTitle', { page: t('pageOrgAdmin'), app: t('appName') })}</title>
  {/if}
</svelte:head>

{#if data.forbidden || organization === null}
  <NotFoundPage slug={data.slug} title={t('pageNotFoundTitle')} text={t('pageNotFoundText')} />
{:else}
  <PageHead
    eyebrow={t('adminEyebrow', { admin: t('admin') })}
    title={t('pageOrgAdmin')}
    tallies={openCount === null
      ? []
      : [{ label: t('workspaceOpenLabel', { workspace: t('workspace') }), count: openCount }]}
  >
    {#snippet actions()}
      <button
        class="btn is-primary"
        type="button"
        onclick={(event) => workspacesSetting?.showCreate(event.currentTarget)}
      >
        <Icon name="plus" />{t('workspaceCreateAction', { workspace: t('workspace') })}
      </button>
    {/snippet}
  </PageHead>

  <div class="settings">
    <WorkspacesSetting
      bind:this={workspacesSetting}
      onopencount={(count) => (openCount = count)}
      slug={data.slug}
      meId={organization.me.id}
      organizationVocabulary={organization.organization.vocabulary}
    />
    <HolidaysSetting slug={data.slug} />
    <OrganizationLookSetting
      slug={data.slug}
      vocabulary={organization.organization.vocabulary}
      theme={organization.organization.theme}
    />
    <HistorySetting slug={data.slug} />
  </div>
{/if}
