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
  import { formatCount, formatGigabytes, formatUtcDate } from '../../lib/format.ts';
  import { formatDateTime } from '../../lib/format-datetime.ts';
  import { isUnauthenticated, loginUrl } from '../../lib/login-redirect.ts';
  import { showToast } from '../../lib/toast.svelte.ts';
  import { t } from '../../lib/vocabulary.svelte.ts';
  import { organizationResume, type SuspensionKind } from '../../shared/operations/operator/index.ts';
  import type { PageProps } from './$types';

  // 運用の画面（design/operator.html）。組織の一覧と、組織の作成、停止と再開。組織の中のデータは出さない。
  // 入れる組織が無い運用者が、ログインの直後にここへ来る。組織ごとの集計（人数と上限、ワークスペースの数、タスクの数、
  // 添付ファイルの上限、最後に使われた日時）は数と日時だけで、人の名前や ID は出さない。人数が上限以上なら「上限に達した」の印を出す。
  // 添付ファイルの使った量は出さない（#68）。管理者の指名し直しは後の Issue で足す。
  // 表は table.is-stacked。狭い幅では、固定した操作の列が名前の列を覆うので、1行を縦に積む（名前、集計、日時、操作）。
  // 積んだ行では、見出しの代わりに data-label を値の前に出す
  // 作成のダイアログは一覧の読み込みの成否に関わらず置く。作った後に一覧の読み直しが失敗しても、完了の表示（組織の URL）を消さない。
  // 「停止する」は確認のダイアログ（停止の理由を選ぶ）を経て、「再開する」は確認なしで送る。
  // 再開を送っている間は、どの行のボタンも aria-disabled にして押しても無視する
  let { data }: PageProps = $props();

  let dialog = $state<ReturnType<typeof CreateOrganizationDialog>>();
  let dialogOpen = $state(false);
  let suspendDialog = $state<ReturnType<typeof OrganizationSuspendDialog>>();
  // 停止の確認の対象。ダイアログの結果を受けるとき、どの行だったかを名前で知らせるのに使う
  let suspending = $state<{ slug: string; name: string; currentKind?: SuspensionKind } | null>(null);
  // 再開を送っている行
  let resumingSlug = $state<string | null>(null);

  const words = $derived({
    organization: t('organization'),
    admin: t('admin'),
    workspace: t('workspace'),
    task: t('task'),
  });

  type Row = { slug: string; name: string; suspended_at: string | null; purge_on: string | null };

  async function resume(row: Row): Promise<void> {
    if (resumingSlug !== null) return;
    resumingSlug = row.slug;
    try {
      const result = await callOperation(organizationResume, { slug: row.slug });
      if (result.ok) {
        showToast(t('operatorResumeDone', { name: row.name }), 'check');
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

  // 停止の確認と、停止の理由を変えるダイアログの結果。どちらのダイアログだったかは、開いたときの対象（currentKind）で分かる
  function suspendFinished(outcome: 'done' | 'state_changed' | 'unavailable' | 'unauthenticated'): void {
    if (outcome === 'unauthenticated') {
      window.location.assign(loginUrl(page.url));
      return;
    }
    const name = suspending?.name ?? '';
    if (outcome === 'done') {
      const key = suspending?.currentKind === undefined ? 'operatorSuspendDone' : 'operatorChangeDone';
      showToast(t(key, { name }), 'check');
    } else if (outcome === 'state_changed') showToast(t('operatorStateChanged', { name }), 'alert');
    else showToast(t('operatorUnavailable', { name }), 'alert');
    void invalidateAll();
  }

  // 停止している組織の今の停止の理由。消す予定日があれば解約
  const kindOf = (row: Row): SuspensionKind => (row.purge_on === null ? 'temporary' : 'cancellation');

  function suspend(row: Row, trigger: HTMLElement): void {
    if (resumingSlug !== null) return;
    suspending = { slug: row.slug, name: row.name };
    suspendDialog?.show(suspending, trigger);
  }

  function changeReason(row: Row, trigger: HTMLElement): void {
    if (resumingSlug !== null) return;
    suspending = { slug: row.slug, name: row.name, currentKind: kindOf(row) };
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
          <table class="table is-stacked">
            <thead>
              <tr>
                <th class="is-name">{t('operatorColumnOrganization', words)}</th>
                <th class="is-num">{t('operatorColumnSeats')}</th>
                <th class="is-num">{t('operatorColumnWorkspaces', words)}</th>
                <th class="is-num">{t('operatorColumnTasks', words)}</th>
                <th class="is-num">{t('operatorColumnQuota')}</th>
                <th>{t('operatorColumnLastUsed')}</th>
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
                        >{t('operatorSuspended', { date: formatUtcDate(organization.suspended_at) })}</span
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
                  <td class="is-num" data-label={t('operatorColumnSeats')}>
                    {t('operatorSeats', { used: organization.seats.used, limit: organization.seats.limit })}
                    {#if organization.seats.used >= organization.seats.limit}
                      <br /><span class="chip is-warn"><Icon name="alert" />{t('operatorSeatsFull')}</span>
                    {/if}
                  </td>
                  <td class="is-num" data-label={t('operatorColumnWorkspaces', words)}
                    >{formatCount(organization.workspace_count)}</td
                  >
                  <td class="is-num" data-label={t('operatorColumnTasks', words)}
                    >{formatCount(organization.task_count)}</td
                  >
                  <td class="is-num" data-label={t('operatorColumnQuota')}
                    >{t('operatorQuotaSize', { size: formatGigabytes(organization.attachment_quota_bytes) })}</td
                  >
                  {#if organization.last_used_at === null}
                    <td class="props-note" data-label={t('operatorColumnLastUsed')}>{t('operatorNeverUsed')}</td>
                  {:else}
                    <td class="mono" data-label={t('operatorColumnLastUsed')}
                      >{formatDateTime(organization.last_used_at)}</td
                    >
                  {/if}
                  <td class="mono" data-label={t('operatorColumnCreated')}>{formatDateTime(organization.created_at)}</td
                  >
                  <td class="is-actions">
                    <!-- 停止中の行は「停止の理由を変える」と「再開する」、それ以外は「停止する」。右端のボタンは同じ要素のまま
                         文字だけを替え、読み直しでフォーカスを失わない。読み上げの名前に、どの組織かを添える。
                         再開を送っている行は、見える文字も「再開しています」にする（名前は据え置く） -->
                    <span class="table-actions">
                      {#if organization.suspended_at !== null}
                        <button
                          class="btn is-sm is-quiet"
                          type="button"
                          aria-disabled={resumingSlug !== null}
                          aria-label={t('operatorChangeLabel', { name: organization.name })}
                          onclick={(event) => changeReason(organization, event.currentTarget)}
                        >
                          {t('operatorChangeAction')}
                        </button>
                      {/if}
                      <button
                        class="btn is-sm is-quiet"
                        class:is-danger={organization.suspended_at === null}
                        type="button"
                        aria-disabled={resumingSlug !== null}
                        aria-label={organization.suspended_at !== null
                          ? t('operatorResumeLabel', { name: organization.name })
                          : t('operatorSuspendLabel', { name: organization.name })}
                        onclick={(event) =>
                          organization.suspended_at !== null
                            ? void resume(organization)
                            : suspend(organization, event.currentTarget)}
                      >
                        {#if resumingSlug === organization.slug}
                          {t('operatorResuming')}
                        {:else if organization.suspended_at !== null}
                          {t('operatorResumeAction')}
                        {:else}
                          {t('operatorSuspendAction')}
                        {/if}
                      </button>
                    </span>
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
<OrganizationSuspendDialog bind:this={suspendDialog} onfinish={suspendFinished} />
