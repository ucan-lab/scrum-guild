<script lang="ts">
  import type { Snippet } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import AppShell from '../../lib/components/AppShell.svelte';
  import Avatar from '../../lib/components/Avatar.svelte';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import Gate from '../../lib/components/Gate.svelte';
  import GateSheet from '../../lib/components/GateSheet.svelte';
  import OrganizationSwitcher from '../../lib/components/OrganizationSwitcher.svelte';
  import { applyOrganization } from '../../lib/organization.svelte.ts';
  import { t } from '../../lib/vocabulary.svelte.ts';
  import type { LayoutData } from './$types';

  // 組織の枠。組織の操作の結果で data-theme と言葉づかいを当て、左のメニューと上の帯を出す。
  // 組織に入れないときと無いときは、どちらも同じ「見つからない」の画面（どちらかを漏らさない）
  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  const organization = $derived(data.organization);

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
  {#if !organization && data.failureStatus === 404}
    <title>{t('pageTitle', { page: t('organizationNotFoundTitle'), app: t('appName') })}</title>
  {/if}
</svelte:head>

{#if organization}
  {#snippet organizationSwitcher()}
    {#if switcherOrganizations}
      <OrganizationSwitcher organizations={switcherOrganizations} currentSlug={data.slug} />
    {/if}
  {/snippet}
  {#snippet account()}
    <span class="me">
      <Avatar userId={organization.me.id} name={organization.me.name} />{organization.me.name}
      {#if organization.me.is_admin}<span class="chip">{t('admin')}</span>{/if}
    </span>
  {/snippet}
  <AppShell
    current={page.url.pathname}
    slug={data.slug}
    hasWorkspace={organization.workspaces.length > 0}
    {organizationSwitcher}
    {account}
  >
    {@render children()}
  </AppShell>
{:else if data.failureStatus === 404}
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
  <Gate>
    <GateSheet brand title={t('loadFailedTitle')}>
      <EmptyState icon="alert" title={t('loadFailedText')}>
        {#snippet actions()}
          <button class="btn is-sm" type="button" onclick={() => invalidateAll()}>{t('retry')}</button>
        {/snippet}
      </EmptyState>
    </GateSheet>
  </Gate>
{/if}
