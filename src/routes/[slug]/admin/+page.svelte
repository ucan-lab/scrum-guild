<script lang="ts">
  import Icon from '../../../lib/components/Icon.svelte';
  import NotFoundPage from '../../../lib/components/NotFoundPage.svelte';
  import PageHead from '../../../lib/components/PageHead.svelte';
  import UsersSetting from '../../../lib/components/admin/UsersSetting.svelte';
  import WorkspacesSetting from '../../../lib/components/admin/WorkspacesSetting.svelte';
  import HolidaysSetting from '../../../lib/components/admin/HolidaysSetting.svelte';
  import OrganizationLookSetting from '../../../lib/components/admin/OrganizationLookSetting.svelte';
  import HistorySetting from '../../../lib/components/admin/HistorySetting.svelte';
  import { t } from '../../../lib/vocabulary.svelte.ts';
  import type { PageProps } from './$types';

  // 組織の管理の画面（admin.html）。節は src/lib/components/admin/ の部品で、それぞれ自分でデータを読む。
  // ほかの節は、部品を足してここに並べる。
  // 管理者でなければ「見つからない」と同じ扱い
  let { data }: PageProps = $props();

  const organization = $derived(data.organization);
  let workspacesSetting = $state<ReturnType<typeof WorkspacesSetting>>();
  // ユーザーの節が読んだ、無効でないユーザーと管理者の数。読めるまでは null で、集計を出さない
  let userCounts = $state<{ users: number; admins: number } | null>(null);
  // ワークスペースの節が読んだ、開いているワークスペースの数。読めるまでは null で、集計を出さない
  let openCount = $state<number | null>(null);

  // 見本（admin.html）と同じく、ユーザー、管理者、進行中のワークスペースの順。節ごとに読めたものから出す
  const tallies = $derived([
    ...(userCounts === null
      ? []
      : [
          { label: t('userTally'), count: userCounts.users, icon: 'users' as const },
          { label: t('admin'), count: userCounts.admins, icon: 'shield' as const },
        ]),
    ...(openCount === null
      ? []
      : [{ label: t('workspaceOpenLabel', { workspace: t('workspace') }), count: openCount }]),
  ]);
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
  <PageHead eyebrow={t('adminEyebrow', { admin: t('admin') })} title={t('pageOrgAdmin')} {tallies}>
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
    <UsersSetting slug={data.slug} meId={organization.me.id} oncounts={(counts) => (userCounts = counts)} />
    <WorkspacesSetting
      bind:this={workspacesSetting}
      onopencount={(count) => (openCount = count)}
      slug={data.slug}
      meId={organization.me.id}
    />
    <HolidaysSetting slug={data.slug} />
    <OrganizationLookSetting slug={data.slug} theme={organization.organization.theme} />
    <HistorySetting slug={data.slug} />
  </div>
{/if}
