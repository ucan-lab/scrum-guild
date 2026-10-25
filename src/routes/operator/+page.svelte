<script lang="ts">
  import CreateOrganizationDialog from '../../lib/components/CreateOrganizationDialog.svelte';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import Gate from '../../lib/components/Gate.svelte';
  import GateSheet from '../../lib/components/GateSheet.svelte';
  import Icon from '../../lib/components/Icon.svelte';
  import LoadFailed from '../../lib/components/LoadFailed.svelte';
  import { t } from '../../lib/vocabulary.svelte.ts';
  import type { PageProps } from './$types';

  // 運用の画面（design/operator.html）。組織の一覧と、組織の作成。組織の中のデータは出さない。
  // 入れる組織が無い運用者が、ログインの直後にここへ来る。人数、ワークスペース数などの集計、停止と再開、
  // 管理者の指名し直しは、後の Issue で足す
  let { data }: PageProps = $props();

  let dialog = $state<ReturnType<typeof CreateOrganizationDialog>>();
  let dialogOpen = $state(false);

  const words = $derived({ organization: t('organization'), admin: t('admin') });

  // 作った日時は UTC の ISO 文字列。日付と時刻までを出す
  const createdAt = (iso: string) => iso.slice(0, 16).replace('T', ' ');
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('pageOperator'), app: t('appName') })}</title>
</svelte:head>

{#if data.failed}
  <LoadFailed />
{:else}
  <Gate wide>
    <GateSheet brand title={t('pageOperator')}>
      <div class="callout is-info"><Icon name="shield" /><span>{t('operatorNotice', words)}</span></div>
      <div class="form-actions">
        <button class="btn is-primary" type="button" onclick={(event) => dialog?.show(event.currentTarget)}>
          <Icon name="plus" />{t('operatorCreate', words)}
        </button>
      </div>
      {#if data.organizations.length === 0}
        <EmptyState icon="shield" title={t('operatorEmptyTitle', words)} text={t('operatorEmptyText', words)} />
      {:else}
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>{t('operatorColumnOrganization', words)}</th>
                <th>{t('operatorColumnCreated')}</th>
              </tr>
            </thead>
            <tbody>
              {#each data.organizations as organization (organization.slug)}
                <tr>
                  <td>
                    {organization.name}
                    {#if organization.suspended_at}<span class="chip is-warn">{t('operatorSuspended')}</span>{/if}
                    {#if organization.admin_status === 'none'}
                      <span class="chip is-danger"><Icon name="alert" />{t('operatorAdminNone', words)}</span>
                    {:else if organization.admin_status === 'pending'}
                      <span class="chip is-warn"><Icon name="clock" />{t('operatorAdminPending', words)}</span>
                    {/if}
                    <br /><span class="mono props-note">{organization.slug}</span>
                  </td>
                  <td class="mono">{createdAt(organization.created_at)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </GateSheet>
  </Gate>
  <CreateOrganizationDialog bind:this={dialog} bind:open={dialogOpen} />
{/if}
