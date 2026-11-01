<script lang="ts">
  import { tick } from 'svelte';
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
  import OrganizationQuotaDialog from '../../lib/components/OrganizationQuotaDialog.svelte';
  import OrganizationSuspendDialog from '../../lib/components/OrganizationSuspendDialog.svelte';
  import ReassignAdminDialog from '../../lib/components/ReassignAdminDialog.svelte';
  import { focusPageHeading } from '../../lib/focus-heading.ts';
  import { formatCount, formatUtcDate, quotaSize } from '../../lib/format.ts';
  import { formatDateTime } from '../../lib/format-datetime.ts';
  import { isUnauthenticated, loginUrl } from '../../lib/login-redirect.ts';
  import { showToast } from '../../lib/toast.svelte.ts';
  import { t } from '../../lib/vocabulary.svelte.ts';
  import { organizationResume, type SuspensionKind } from '../../shared/operations/operator/index.ts';
  import type { PageProps } from './$types';

  // 運用の画面（design/operator.html）。組織の一覧と、組織の作成、停止と再開。組織の中のデータは出さない。
  // 入れる組織が無い運用者が、ログインの直後にここへ来る。組織ごとの集計（人数と上限、ワークスペースの数、タスクの数、
  // 添付ファイルの上限、最後に使われた日時）は数と日時だけで、人の名前や ID は出さない。人数が上限以上なら「上限に達した」の印を出す。
  // 添付ファイルの使った量は出さない（#68）。
  // 各行の「管理者を指名」は、管理者の状態に関わらず（停止中の組織にも）置き、指名し直しのダイアログを開く。
  // ダイアログは指名した後に閉じると一覧を読み直す（管理者の状態の印が変わる）。
  // 作った日時は列にせず、名前の列の slug の行に並べる（1280px の画面で表が横スクロールせずに収まる列の数にするため）。
  // 表は table.is-stacked。狭い幅では、固定した操作の列が名前の列を覆うので、1行を縦に積む（名前、集計、日時、操作）。
  // 積んだ行では、見出しの代わりに data-label を値の前に出す
  // 作成のダイアログは一覧の読み込みの成否に関わらず置く。作った後に一覧の読み直しが失敗しても、完了の表示（組織の URL）を消さない。
  // 「停止する」は確認のダイアログ（停止の理由を選ぶ）を経て、「再開する」は確認なしで送る。
  // 再開を送っている間は、どの行のボタンも aria-disabled にして押しても無視する。
  // 解約で消す予定日を過ぎた組織（一覧の purge_due）の行は、「管理者を指名」「停止の理由を変える」「再開する」を出さず、できない理由を出す
  // （サーバーは管理者の指名し直し、再開、一時的な停止への切り替えを 409 の purge_due で断る）。画面を開いた後に日付が変わって purge_due で断られたときは、
  // 理由をトーストで出して一覧を読み直し、押したボタンが消えるので、その行の理由へフォーカスを移す。
  // 添付ファイルの上限の列の「人数と容量の上限を変える」（link-btn）は、上限の変更のダイアログを開く。変えた後は一覧を読み直す
  let { data }: PageProps = $props();
  const ids = $props.id();

  let dialog = $state<ReturnType<typeof CreateOrganizationDialog>>();
  let dialogOpen = $state(false);
  let suspendDialog = $state<ReturnType<typeof OrganizationSuspendDialog>>();
  let reassignDialog = $state<ReturnType<typeof ReassignAdminDialog>>();
  let quotaDialog = $state<ReturnType<typeof OrganizationQuotaDialog>>();
  // 上限の変更の対象の組織の名前。ダイアログの結果のトーストに使う
  let quotaName = $state('');
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

  // 添付ファイルの上限。1 GB 以上は GB、それ未満は MB で出す
  function quotaText(bytes: number): string {
    const quota = quotaSize(bytes);
    return t(quota.unit === 'gb' ? 'operatorQuotaSize' : 'operatorQuotaSizeMb', { size: quota.size });
  }

  type Row = { slug: string; name: string; suspended_at: string | null; purge_on: string | null };

  async function resume(row: Row): Promise<void> {
    if (resumingSlug !== null) return;
    resumingSlug = row.slug;
    try {
      const result = await callOperation(organizationResume, { slug: row.slug });
      if (result.ok) {
        showToast(t('operatorResumeDone', { name: row.name }), 'check');
      } else if (isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      } else if (result.status === 409 && result.error?.code === 'conflict') {
        // 別の画面で先に操作されていた。再開されたのか、停止し直されたのかは言い切らず、読み直した一覧を見てもらう
        showToast(t('operatorStateChanged', { name: row.name }), 'alert');
      } else if (result.status === 409 && result.error?.code === 'purge_due') {
        showToast(t('operatorResumePurgeDue', { name: row.name }), 'alert');
        await invalidateAll();
        await focusPurgeDue(row.slug);
        return;
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
  function suspendFinished(outcome: 'done' | 'state_changed' | 'purge_due' | 'unavailable' | 'unauthenticated'): void {
    if (outcome === 'unauthenticated') {
      window.location.assign(loginUrl(page.url));
      return;
    }
    const name = suspending?.name ?? '';
    if (outcome === 'done') {
      const key = suspending?.currentKind === undefined ? 'operatorSuspendDone' : 'operatorChangeDone';
      showToast(t(key, { name }), 'check');
    } else if (outcome === 'state_changed') showToast(t('operatorStateChanged', { name }), 'alert');
    else if (outcome === 'purge_due') {
      showToast(t('operatorChangePurgeDue', { name }), 'alert');
      const slug = suspending?.slug;
      void invalidateAll().then(() => {
        if (slug !== undefined) void focusPurgeDue(slug);
      });
      return;
    } else showToast(t('operatorUnavailable', { name }), 'alert');
    void invalidateAll();
  }

  // 管理者の指名し直しのダイアログが purge_due を受けた（開いた後に予定日を過ぎた）。扱いは再開と同じ
  function reassignPurgeDue(organization: { slug: string; name: string }): void {
    showToast(t('operatorReassignPurgeDue', { ...words, name: organization.name }), 'alert');
    void invalidateAll().then(() => focusPurgeDue(organization.slug));
  }

  // 消す予定日を過ぎた組織の行の、できない理由の注記。押したボタンが読み直しで消えたときのフォーカスの移し先
  const purgeDueId = (slug: string) => `${ids}-purge-due-${slug}`;

  // 注記が見つからない（読み直しが失敗した、読み直した行がまだ purge_due でない）ときは、画面の見出しへ移す
  async function focusPurgeDue(slug: string): Promise<void> {
    await tick();
    const note = document.getElementById(purgeDueId(slug));
    if (note) note.focus();
    else focusPageHeading();
  }

  // 上限の変更のダイアログの結果。扱いは停止のダイアログと同じ
  function quotaFinished(outcome: 'done' | 'state_changed' | 'unavailable' | 'unauthenticated'): void {
    if (outcome === 'unauthenticated') {
      window.location.assign(loginUrl(page.url));
      return;
    }
    const name = quotaName;
    if (outcome === 'done') showToast(t('operatorQuotaDone', { name }), 'check');
    else if (outcome === 'state_changed') showToast(t('operatorStateChanged', { name }), 'alert');
    else showToast(t('operatorUnavailable', { name }), 'alert');
    void invalidateAll();
  }

  function changeQuota(
    row: { slug: string; name: string; seats: { used: number; limit: number }; attachment_quota_bytes: number },
    trigger: HTMLElement,
  ): void {
    if (resumingSlug !== null) return;
    quotaName = row.name;
    quotaDialog?.show(row, trigger);
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
                <th class="is-actions"><span class="visually-hidden">{t('operatorActionsHeader')}</span></th>
              </tr>
            </thead>
            <tbody>
              {#each data.organizations as organization (organization.slug)}
                <tr>
                  <td class="is-name">
                    {organization.name}
                    {#if organization.self_created}<span class="chip">{t('operatorSelfCreated')}</span>{/if}
                    {#if organization.trial_ends_on !== null}
                      <span class="chip">{t('orgTrialEndsOn', { date: organization.trial_ends_on })}</span>
                      {#if organization.trial_expired}<span class="chip is-danger"
                          ><Icon name="alert" />{t('trialExpired')}</span
                        >{/if}
                    {/if}
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
                    <!-- slug と日時はキーと日付なので等幅の書体（.mono）で出す -->
                    <br /><span class="props-note"
                      ><span class="mono">{organization.slug}</span> · {t('operatorCreatedLabel')}
                      <span class="mono">{formatDateTime(organization.created_at)}</span></span
                    >
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
                  <td class="is-num" data-label={t('operatorColumnQuota')}>
                    {quotaText(organization.attachment_quota_bytes)}
                    <!-- 人数と添付ファイルの上限をまとめて変える。読み上げの名前に、どの組織かを添える -->
                    <br /><button
                      class="link-btn"
                      type="button"
                      aria-disabled={resumingSlug !== null}
                      aria-label={t('operatorQuotaLabel', { name: organization.name })}
                      onclick={(event) => changeQuota(organization, event.currentTarget)}
                      >{t('operatorQuotaAction')}</button
                    >
                  </td>
                  {#if organization.last_used_at === null}
                    <td class="props-note" data-label={t('operatorColumnLastUsed')}>{t('operatorNeverUsed')}</td>
                  {:else}
                    <td class="mono" data-label={t('operatorColumnLastUsed')}
                      >{formatDateTime(organization.last_used_at)}</td
                    >
                  {/if}
                  <td class="is-actions">
                    <!-- 停止中の行は「停止の理由を変える」と「再開する」、それ以外は「停止する」。右端のボタンは同じ要素のまま
                         文字だけを替え、読み直しでフォーカスを失わない。読み上げの名前に、どの組織かを添える。
                         再開を送っている行は、見える文字も「再開しています」にする（名前は据え置く）。
                         消す予定日を過ぎた行は、操作を出さず、できない理由だけ -->
                    <span class="table-actions is-wrap">
                      {#if organization.purge_due}
                        <!-- 消す予定日を過ぎた組織は、管理者の指名、停止の理由の切り替え、再開を出さず、できない理由を出す
                             （サーバーはどれも 409 の purge_due で断る）。断られた後のフォーカスの移し先にするので、tabindex="-1" -->
                        <span class="props-note" id={purgeDueId(organization.slug)} tabindex="-1"
                          >{t('operatorPurgeDue', words)}</span
                        >
                      {:else}
                        <button
                          class="btn is-sm is-quiet"
                          type="button"
                          aria-disabled={resumingSlug !== null}
                          aria-label={t('operatorReassignLabel', { ...words, name: organization.name })}
                          onclick={(event) => {
                            if (resumingSlug === null) reassignDialog?.show(organization, event.currentTarget);
                          }}
                        >
                          {t('operatorReassignAction', words)}
                        </button>
                      {/if}
                      {#if !organization.purge_due && organization.suspended_at !== null}
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
                      {#if !organization.purge_due}
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
                      {/if}
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
<ReassignAdminDialog bind:this={reassignDialog} onpurgedue={reassignPurgeDue} />
<OrganizationQuotaDialog bind:this={quotaDialog} onfinish={quotaFinished} />
