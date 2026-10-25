<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { callOperation } from '../../lib/api.ts';
  import CreateOrganizationDialog from '../../lib/components/CreateOrganizationDialog.svelte';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import Gate from '../../lib/components/Gate.svelte';
  import GateSheet from '../../lib/components/GateSheet.svelte';
  import Icon from '../../lib/components/Icon.svelte';
  import LoadFailed from '../../lib/components/LoadFailed.svelte';
  import LogoutButton from '../../lib/components/LogoutButton.svelte';
  import OrganizationSuspendDialog from '../../lib/components/OrganizationSuspendDialog.svelte';
  import { formatLocalDate } from '../../lib/format.ts';
  import { formatDateTime } from '../../lib/format-datetime.ts';
  import { isUnauthenticated, loginUrl } from '../../lib/login-redirect.ts';
  import { showToast } from '../../lib/toast.svelte.ts';
  import { t } from '../../lib/vocabulary.svelte.ts';
  import { organizationResume } from '../../shared/operations/operator/index.ts';
  import type { PageProps } from './$types';

  // 運用の画面（design/operator.html）。組織の一覧と、組織の作成、停止と再開。組織の中のデータは出さない。
  // 入れる組織が無い運用者が、ログインの直後にここへ来る。人数、ワークスペース数などの集計、
  // 管理者の指名し直しは、後の Issue で足す。
  // 作成のダイアログは一覧の読み込みの成否に関わらず置く。作った後に一覧の読み直しが失敗しても、完了の表示（組織の URL）を消さない。
  // 「停止する」は確認のダイアログ（停止の理由を選ぶ）を経て、「再開する」は確認なしで送る。
  // 再開を送っている間は、どの行のボタンも aria-disabled にして押しても無視する
  let { data }: PageProps = $props();

  let dialog = $state<ReturnType<typeof CreateOrganizationDialog>>();
  let dialogOpen = $state(false);
  let suspendDialog = $state<ReturnType<typeof OrganizationSuspendDialog>>();
  // 停止の確認の対象。ダイアログの結果を受けるとき、どの行だったかを名前で知らせるのに使う
  let suspending = $state<{ slug: string; name: string } | null>(null);
  // 再開を送っている行
  let resumingSlug = $state<string | null>(null);

  const words = $derived({ organization: t('organization'), admin: t('admin') });

  type Row = { slug: string; name: string; suspended_at: string | null };

  async function resume(row: Row): Promise<void> {
    if (resumingSlug !== null) return;
    resumingSlug = row.slug;
    try {
      const result = await callOperation(organizationResume, { slug: row.slug });
      if (result.ok) {
        showToast(t('operatorResumeDone', words), 'check');
      } else if (isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url, result));
        return;
      } else if (result.status === 409 && result.error?.code === 'conflict') {
        // 別の画面で先に操作されていた。再開されたのか、停止し直されたのかは言い切らず、読み直した一覧を見てもらう
        showToast(t('operatorStateChanged', { name: row.name }), 'alert');
      } else if (result.status === 404 || result.status === 403) {
        showToast(t('operatorUnavailable', { name: row.name }), 'alert');
      } else {
        showToast(t('operatorResumeFailed', words), 'alert');
      }
      await invalidateAll();
    } finally {
      resumingSlug = null;
    }
  }

  function suspendFinished(
    name: string,
    outcome: 'suspended' | 'state_changed' | 'unavailable' | 'unauthenticated',
  ): void {
    if (outcome === 'unauthenticated') {
      window.location.assign(loginUrl(page.url));
      return;
    }
    if (outcome === 'suspended') showToast(t('operatorSuspendDone', words), 'check');
    else if (outcome === 'state_changed') showToast(t('operatorStateChanged', { name }), 'alert');
    else showToast(t('operatorUnavailable', { name }), 'alert');
    void invalidateAll();
  }

  function act(row: Row, trigger: HTMLElement): void {
    if (resumingSlug !== null) return;
    if (row.suspended_at !== null) {
      void resume(row);
      return;
    }
    suspending = { slug: row.slug, name: row.name };
    suspendDialog?.show(suspending, trigger);
  }

  // 再開を送っている間の読み上げ。領域は常に置き、中の文字だけを替える
  const status = $derived(resumingSlug !== null ? t('operatorResuming') : '');
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('pageOperator'), app: t('appName') })}</title>
</svelte:head>

{#if data.failed}
  <LoadFailed />
{:else}
  <Gate wide>
    <GateSheet brand title={t('pageOperator')}>
      <div class="form-actions">
        <button class="btn is-primary" type="button" onclick={(event) => dialog?.show(event.currentTarget)}>
          <Icon name="plus" />{t('operatorCreate', words)}
        </button>
      </div>
      <div class="callout is-info"><Icon name="shield" /><span>{t('operatorNotice', words)}</span></div>
      {#if data.organizations.length === 0}
        <EmptyState icon="shield" title={t('operatorEmptyTitle', words)} text={t('operatorEmptyText', words)} />
      {:else}
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th class="is-name">{t('operatorColumnOrganization', words)}</th>
                <th>{t('operatorColumnCreated')}</th>
                <th class="is-actions"><span class="visually-hidden">{t('operatorActionsHeader')}</span></th>
              </tr>
            </thead>
            <tbody>
              {#each data.organizations as organization (organization.slug)}
                <tr>
                  <td class="is-name">
                    {organization.name}
                    {#if organization.suspended_at}
                      <span class="chip is-warn"
                        >{t('operatorSuspended', { date: formatLocalDate(organization.suspended_at) })}</span
                      >
                    {/if}
                    {#if organization.suspended_at && organization.purge_on}
                      <span class="chip is-danger">{t('operatorPurgeOn', { date: organization.purge_on })}</span>
                    {/if}
                    {#if organization.admin_status === 'none'}
                      <span class="chip is-danger"><Icon name="alert" />{t('operatorAdminNone', words)}</span>
                    {:else if organization.admin_status === 'pending'}
                      <span class="chip is-warn"><Icon name="clock" />{t('operatorAdminPending', words)}</span>
                    {:else if organization.admin_status === 'expired'}
                      <span class="chip is-danger"><Icon name="alert" />{t('operatorAdminExpired', words)}</span>
                    {/if}
                    <br /><span class="mono props-note">{organization.slug}</span>
                  </td>
                  <td class="mono">{formatDateTime(organization.created_at)}</td>
                  <td class="is-actions">
                    <!-- 停止中の行は「再開する」、それ以外は「停止する」。同じ要素のまま文字だけを替え、読み直しでフォーカスを失わない。
                         読み上げの名前に、どの組織かを添える -->
                    <button
                      class="btn is-sm is-quiet"
                      class:is-danger={organization.suspended_at === null}
                      type="button"
                      aria-disabled={resumingSlug !== null}
                      aria-label={organization.suspended_at !== null
                        ? t('operatorResumeLabel', { name: organization.name })
                        : t('operatorSuspendLabel', { name: organization.name })}
                      onclick={(event) => act(organization, event.currentTarget)}
                    >
                      {organization.suspended_at !== null ? t('operatorResumeAction') : t('operatorSuspendAction')}
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      <span class="visually-hidden" role="status">{status}</span>
      <div class="form-actions"><LogoutButton /></div>
    </GateSheet>
  </Gate>
{/if}
<CreateOrganizationDialog
  bind:this={dialog}
  bind:open={dialogOpen}
  organizations={data.failed ? [] : data.organizations}
/>
<OrganizationSuspendDialog
  bind:this={suspendDialog}
  onfinish={(outcome) => suspendFinished(suspending?.name ?? '', outcome)}
/>
