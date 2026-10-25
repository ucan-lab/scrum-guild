<script lang="ts">
  import type { Snippet } from 'svelte';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import AccountMenu from '../../lib/components/AccountMenu.svelte';
  import AppShell from '../../lib/components/AppShell.svelte';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import Gate from '../../lib/components/Gate.svelte';
  import GateSheet from '../../lib/components/GateSheet.svelte';
  import LoadFailed from '../../lib/components/LoadFailed.svelte';
  import OrganizationSwitcher from '../../lib/components/OrganizationSwitcher.svelte';
  import { applyOrganization } from '../../lib/organization.svelte.ts';
  import { t } from '../../lib/vocabulary.svelte.ts';
  import { workspaceViewOf } from '../../lib/workspace.ts';
  import type { LayoutData } from './$types';

  // 組織の枠。組織の操作の結果で data-theme と言葉づかいを当て、左のメニューと上の帯を出す。
  // 組織に入れないときと無いときは、どちらも同じ「見つからない」の画面（どちらかを漏らさない）。
  // 見つからないのは、API が not_found の 404 を返したときだけ。ほかの失敗（通信、5xx、権限）は読み込みの失敗
  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  const organization = $derived(data.organization);
  const notFound = $derived(data.failure?.status === 404 && data.failure.code === 'not_found');
  // 今開いているワークスペース（/[slug]/w/[id] の枠が読み込む）。メニューにワークスペースの節を出し、
  // 所属していない管理者には印を出す。ワークスペースの画面の外では null
  const openWorkspace = $derived(workspaceViewOf(page.data));

  $effect(() => {
    if (organization) applyOrganization(organization);
  });

  // 切り替えは、入れる組織が2つ以上あるか、届いた招待があるときに出す（招待は組織の選択の画面で見る）
  const switcherOrganizations = $derived(
    data.organizations !== null &&
      (data.organizations.organizations.length > 1 || data.organizations.invitations.length > 0)
      ? data.organizations.organizations
      : null,
  );
</script>

<!-- 組織の中の画面は、それぞれの題名を持つ。見つからない画面だけが、ここで題名を決める -->
<svelte:head>
  {#if !organization && notFound}
    <title>{t('pageTitle', { page: t('organizationNotFoundTitle'), app: t('appName') })}</title>
  {/if}
</svelte:head>

{#if organization}
  {#snippet organizationSwitcher()}
    {#if switcherOrganizations}
      <OrganizationSwitcher
        organizations={switcherOrganizations}
        currentSlug={data.slug}
        fallbackName={organization.organization.name}
        invited={(data.organizations?.invitations.length ?? 0) > 0}
      />
    {/if}
  {/snippet}
  {#snippet account()}
    <!-- 所属していない管理者がワークスペースの画面を開いているときの印。所属していないことを、画面のどこからでも見て分かるようにする -->
    {#if openWorkspace?.role === null}
      <span class="chip">{t('notMemberAdminChip', { admin: t('admin') })}</span>
    {/if}
    <AccountMenu userId={organization.me.id} name={organization.me.name} isAdmin={organization.me.is_admin} />
  {/snippet}
  {#snippet workspaceSwitcher()}
    {#if openWorkspace}
      <div class="ws-select"><span>{t('workspace')}</span><b>{openWorkspace.name}</b></div>
    {/if}
  {/snippet}
  <AppShell
    current={page.url.pathname}
    slug={data.slug}
    hasWorkspace={organization.workspaces.length > 0}
    isAdmin={organization.me.is_admin}
    {organizationSwitcher}
    workspaceSwitcher={openWorkspace ? workspaceSwitcher : undefined}
    {account}
  >
    {@render children()}
  </AppShell>
{:else if notFound}
  <Gate>
    <GateSheet brand title={t('organizationNotFoundTitle')}>
      <EmptyState icon="search" title={t('organizationNotFoundText')}>
        {#snippet actions()}
          <a class="btn is-sm" href={resolve('/')}>{t('organizationList')}</a>
        {/snippet}
      </EmptyState>
    </GateSheet>
  </Gate>
{:else}
  <LoadFailed />
{/if}
