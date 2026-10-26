<script lang="ts">
  import { tick } from 'svelte';
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { callOperation } from '../../../../../lib/api.ts';
  import ConfirmDialog from '../../../../../lib/components/ConfirmDialog.svelte';
  import EmptyState from '../../../../../lib/components/EmptyState.svelte';
  import Icon from '../../../../../lib/components/Icon.svelte';
  import LoadFailed from '../../../../../lib/components/LoadFailed.svelte';
  import PageHead from '../../../../../lib/components/PageHead.svelte';
  import SprintDialog from '../../../../../lib/components/SprintDialog.svelte';
  import { formatMonthDay } from '../../../../../lib/format.ts';
  import { isUnauthenticated, loginUrl } from '../../../../../lib/login-redirect.ts';
  import { showToast } from '../../../../../lib/toast.svelte.ts';
  import { t } from '../../../../../lib/vocabulary.svelte.ts';
  import {
    sprintConflictReasonOf,
    sprintDelete,
    type SprintSummary,
  } from '../../../../../shared/operations/sprint/index.ts';
  import type { PageProps } from './$types';

  // 計画の画面（design/plan.html）。今は、先のスプリントと進行中のスプリントを開始日の順に `.lane` で並べ、
  // 名前（無ければ期間）、進行中の印、期間と長さを出す。入っているタスク、積載量、ベロシティ、エピックごとの残りは、それぞれの Issue（#238、#244）で足す。
  // 見出しの右の「<スプリント>を作る」と、始まる前のスプリントの「直す」「削除する」は、リーダー（管理者を含む）にだけ、
  // 終了していないワークスペースでだけ出す。作ると直すは SprintDialog、削除は確かめのダイアログ（ConfirmDialog）を通す。
  // 終わったら一覧だけを読み直す（`app:sprints`）。削除した後は、押した行が消えるので見出しへフォーカスを移す
  let { data }: PageProps = $props();

  const workspace = $derived(data.workspace);
  const plan = $derived(data.plan);
  const slug = $derived(page.params.slug ?? '');
  const isAdmin = $derived(data.organization?.me.is_admin === true);
  // 作る、直す、削除するのは、終了していないワークスペースのリーダーと管理者だけ（API も同じ権限で断る）
  const isLeader = $derived(workspace !== null && (workspace.role === 'leader' || isAdmin));
  const isClosed = $derived(workspace !== null && workspace.closedAt !== null);
  const canLead = $derived(isLeader && !isClosed);
  // 空の状態の補足。作れない理由を、終了したワークスペースか、リーダーでないかで分ける
  const emptyNote = $derived(
    isClosed
      ? t('sprintEmptyClosedText', { sprint: t('sprint'), workspace: t('workspace') })
      : isLeader
        ? ''
        : t('sprintEmptyWho', { sprint: t('sprint'), leader: t('leader') }),
  );

  let sprintDialog = $state<ReturnType<typeof SprintDialog>>();
  let confirmDelete = $state<ReturnType<typeof ConfirmDialog>>();
  // 削除の確かめに出すスプリントと、削除を送っている最中か
  let deleteTarget = $state<SprintSummary | null>(null);
  let deleting = $state(false);

  function labelOf(sprint: SprintSummary): string {
    return sprint.name === null
      ? t('sprintLabelPeriod', {
          sprint: t('sprint'),
          start: formatMonthDay(sprint.start_on),
          end: formatMonthDay(sprint.end_on),
        })
      : t('sprintLabelNamed', { sprint: t('sprint'), name: sprint.name });
  }

  function periodOf(sprint: SprintSummary): string {
    return t('sprintPeriod', { start: formatMonthDay(sprint.start_on), end: formatMonthDay(sprint.end_on) });
  }

  async function reload(): Promise<void> {
    await invalidate('app:sprints');
  }

  function focusHeading(): void {
    document.querySelector<HTMLElement>('h1.page-title')?.focus();
  }

  function openCreate(event: MouseEvent): void {
    if (plan === null) return;
    sprintDialog?.show(event.currentTarget as HTMLElement, null, plan.defaults);
  }

  function openEdit(event: MouseEvent, sprint: SprintSummary): void {
    if (plan === null) return;
    sprintDialog?.show(event.currentTarget as HTMLElement, sprint, plan.defaults);
  }

  // 失敗は、どれももう一度押しても直らないことが多いので、トーストで知らせて読み直す
  async function remove(event: MouseEvent, sprint: SprintSummary): Promise<void> {
    if (deleting || workspace === null) return;
    deleteTarget = sprint;
    const confirmed = (await confirmDelete?.ask(event.currentTarget as HTMLElement)) ?? false;
    if (!confirmed) return;
    deleting = true;
    try {
      const result = await callOperation(sprintDelete, { workspace_id: workspace.id, sprint_id: sprint.id }, { slug });
      if (!result.ok && isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      const words = { sprint: t('sprint'), workspace: t('workspace'), leader: t('leader') };
      if (result.ok) showToast(t('sprintDeleted', words), 'check');
      else if (result.error?.code === 'workspace_closed') {
        showToast(t('workspaceClosedReadOnly', words), 'alert');
        await invalidate('app:workspace');
      } else if (sprintConflictReasonOf(result.error?.details) === 'started') {
        showToast(t('sprintDeleteStarted', words), 'alert');
      } else if (result.status === 404) showToast(t('sprintGone', words), 'alert');
      else if (result.status === 403) {
        showToast(t('sprintForbidden', words), 'alert');
        await invalidate('app:workspace');
      } else showToast(t('sprintDeleteFailed'), 'alert');
      await reload();
    } finally {
      deleting = false;
    }
    await tick();
    focusHeading();
  }

  const sprintWords = $derived({
    sprint: t('sprint'),
    task: t('task'),
    points: t('points'),
    capacity: t('capacity'),
    leader: t('leader'),
  });
</script>

<svelte:head>
  {#if workspace && plan !== null}
    <title>
      {t('pageTitle', { page: t('planPageName', { plan: t('plan'), name: workspace.name }), app: t('appName') })}
    </title>
  {/if}
</svelte:head>

{#if workspace && plan === null}
  <LoadFailed inShell />
{:else if workspace && plan !== null}
  <PageHead title={t('plan')} eyebrow={workspace.name} focusable>
    {#snippet actions()}
      {#if canLead}
        <button class="btn is-primary" type="button" onclick={openCreate}
          ><Icon name="plus" />{t('sprintCreate', sprintWords)}</button
        >
      {/if}
    {/snippet}
  </PageHead>

  <!-- 読み上げの領域。常に置き、文字だけを替える -->
  <div class="visually-hidden" role="status">{deleting ? t('sprintDeleting') : ''}</div>

  {#if plan.sprints.length === 0}
    <EmptyState
      icon="calendar"
      title={t('sprintEmptyTitle', sprintWords)}
      text={t('sprintEmptyText', sprintWords) + emptyNote}
    />
  {:else}
    <div class="lanes">
      {#each plan.sprints as sprint (sprint.id)}
        <section class="lane" class:is-active={sprint.status === 'active'}>
          <div class="lane-head">
            <h2 class="lane-title">{labelOf(sprint)}</h2>
            {#if sprint.status === 'active'}<span class="chip is-ok">{t('sprintActive')}</span>{/if}
          </div>
          <div class="lane-sub">
            <span class="mono">{periodOf(sprint)}</span>
            <span>{t('sprintLengthDays', { length: sprint.length })}</span>
          </div>
          {#if canLead && sprint.status === 'planned'}
            <div class="form-actions">
              <button
                class="btn is-sm"
                type="button"
                aria-label={t('sprintEditLabel', { label: labelOf(sprint) })}
                aria-disabled={deleting}
                onclick={(event) => !deleting && openEdit(event, sprint)}
                ><Icon name="pen" />{t('sprintEditAction')}</button
              >
              <button
                class="btn is-sm is-quiet is-danger"
                type="button"
                aria-label={t('sprintDeleteLabel', { label: labelOf(sprint) })}
                aria-disabled={deleting}
                onclick={(event) => void remove(event, sprint)}><Icon name="trash" />{t('sprintDeleteAction')}</button
              >
            </div>
          {/if}
        </section>
      {/each}
    </div>
  {/if}

  {#key workspace.id}
    <SprintDialog bind:this={sprintDialog} {slug} workspaceId={workspace.id} onsaved={reload} ongone={reload} />
  {/key}
  <ConfirmDialog
    bind:this={confirmDelete}
    title={t('sprintDeleteTitle', sprintWords)}
    confirmLabel={t('sprintDeleteAction')}
    cancelLabel={t('cancel')}
    danger
  >
    {#if deleteTarget !== null}
      <p>{t('sprintDeleteText', { label: labelOf(deleteTarget), period: periodOf(deleteTarget) })}</p>
    {/if}
  </ConfirmDialog>
{/if}
