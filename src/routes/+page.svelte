<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import Gate from '../lib/components/Gate.svelte';
  import GateSheet from '../lib/components/GateSheet.svelte';
  import { t } from '../lib/vocabulary.svelte.ts';
  import type { PageProps } from './$types';

  // 組織の選択。入れる組織が2つ以上の人と、届いた招待がある人に出す（1つだけで招待も無い人は +page.ts が組織へ移す）。
  // 承諾と辞退は別の画面で作る。ここは招待が届いていることと、組織の名前だけを出す
  let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('organizationChooseTitle'), app: t('appName') })}</title>
</svelte:head>

<Gate>
  {#if data.failed}
    <GateSheet brand title={t('organizationChooseTitle')}>
      <EmptyState icon="alert" title={t('loadFailedText')}>
        {#snippet actions()}
          <button class="btn is-sm" type="button" onclick={() => invalidateAll()}>{t('retry')}</button>
        {/snippet}
      </EmptyState>
    </GateSheet>
  {:else}
    <GateSheet brand title={t('organizationChooseTitle')}>
      {#if data.organizations.length > 0}
        <p>{t('organizationChooseLead', { count: data.organizations.length })}</p>
        <div class="choice-list">
          {#each data.organizations as organization (organization.slug)}
            <a class="choice" href={resolve('/[slug]', { slug: organization.slug })}>
              <div>
                <b>{organization.name}</b>
                <span class="mono">{page.url.host}/{organization.slug}/</span>
              </div>
            </a>
          {/each}
        </div>
        <p class="gate-note">{t('organizationChooseNote')}</p>
      {:else}
        <EmptyState icon="shield" title={t('noOrganizationTitle')} text={t('noOrganizationText')} />
      {/if}
      {#if data.operator}
        <a class="btn is-sm" href={resolve('/operator')}>{t('operatorOpen')}</a>
      {/if}
    </GateSheet>
    {#if data.invitations.length > 0}
      <GateSheet title={t('invitationsHeading')}>
        {#each data.invitations as invitation, index (index)}
          <div class="panel">
            <b>{invitation.organization_name}</b>
            <span class="panel-note">{t('invitationPending')}</span>
          </div>
        {/each}
        <p class="gate-note">{t('invitationsNote')}</p>
      </GateSheet>
    {/if}
  {/if}
</Gate>
