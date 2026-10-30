<script lang="ts">
  import { tick } from 'svelte';
  import { invalidate } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { callOperation } from '../../../../../lib/api.ts';
  import Avatar from '../../../../../lib/components/Avatar.svelte';
  import ConfirmDialog from '../../../../../lib/components/ConfirmDialog.svelte';
  import EmptyState from '../../../../../lib/components/EmptyState.svelte';
  import Icon from '../../../../../lib/components/Icon.svelte';
  import LoadFailed from '../../../../../lib/components/LoadFailed.svelte';
  import PageHead, { type Tally } from '../../../../../lib/components/PageHead.svelte';
  import PlanEpics from '../../../../../lib/components/PlanEpics.svelte';
  import PlanLaneFill from '../../../../../lib/components/PlanLaneFill.svelte';
  import PlanVelocity from '../../../../../lib/components/PlanVelocity.svelte';
  import SprintCloseDialog from '../../../../../lib/components/SprintCloseDialog.svelte';
  import SprintDialog from '../../../../../lib/components/SprintDialog.svelte';
  import SprintOverdueNotice from '../../../../../lib/components/SprintOverdueNotice.svelte';
  import SprintStartDialog from '../../../../../lib/components/SprintStartDialog.svelte';
  import SprintTaskPicker from '../../../../../lib/components/SprintTaskPicker.svelte';
  import { focusPageHeading } from '../../../../../lib/focus-heading.ts';
  import { isUnauthenticated, loginUrl } from '../../../../../lib/login-redirect.ts';
  import { formatPoints, isOverVelocity } from '../../../../../lib/plan-summary.ts';
  import { sprintLabel, sprintPeriod } from '../../../../../lib/sprint-label.ts';
  import { showToast } from '../../../../../lib/toast.svelte.ts';
  import { t } from '../../../../../lib/vocabulary.svelte.ts';
  import {
    sprintConflictReasonOf,
    sprintDelete,
    sprintTaskConflictReasonOf,
    sprintTaskRemove,
    type SprintPlan,
    type SprintSummary,
    type SprintTask,
  } from '../../../../../shared/operations/sprint/index.ts';
  import type { PageProps } from './$types';

  // 計画の画面（design/plan.html）。先のスプリントと進行中のスプリントを開始日の順に `.lane` で並べ、
  // 名前（無ければ期間）、進行中の印、期間と長さ、入っているタスクの件数とポイントの合計、入っているタスクの行（`.lane-row`）を出す。
  // 積載量は #66 で足す。集計（plan-summary）は、見出しの集計（ベロシティ、超過した先のスプリントの数、未見積もりの件数）、ベロシティ
  // （PlanVelocity）、先のスプリントごとの入れたポイントの棒（PlanLaneFill。ベロシティを上回れば、棒を赤にして文字でも示す）と未見積もりの件数、
  // エピックごとの残りの表（PlanEpics）に出す。集計だけが読めなかったときは、先のスプリントの一覧は出して、集計の場所に読み直す口を出す。
  // 先のスプリントも終了したスプリントも無いワークスペースは、集計を出さず空の状態だけを出す。
  // 行はポイント、タイトル（`?task=<ID>` で詳細の引き出しを開く）、担当と、完了していないタスクの「外す」（`.icon-btn`）。
  // 行の下の「<バックログ>から入れる」は、タスクとストーリーを選ぶダイアログ（SprintTaskPicker）を開く。入れる、外すはメンバーの操作で、
  // 終了していないワークスペースでだけ出す。
  // 進行中のスプリントには、始めるときに書いたゴールを期間の下に出す。始まる前のスプリントの「始める」は、ゴールの欄のあるダイアログ
  // （SprintStartDialog）を開く。進行中のスプリントが既にあれば、ダイアログが理由を出して始められなくする。
  // 見出しの右の「<スプリント>を作る」と、始まる前のスプリントの「始める」「直す」「削除する」は、リーダー（管理者を含む）にだけ、
  // 終了していないワークスペースでだけ出す。作ると直すは SprintDialog、削除は確かめのダイアログ（ConfirmDialog）を通す。
  // 終わったら一覧だけを読み直す（`app:sprints`）。削除した後は、押した行が消えるので見出しへフォーカスを移す。
  // 外した後は、行が消えるので同じスプリントの「<バックログ>から入れる」へフォーカスを移す。
  // 最終日がワークスペースの今日より前の進行中のスプリントには、終えるのを促す警告（SprintOverdueNotice）を出す。
  // リーダー（管理者を含む）には「終える」を添え、スプリントの画面と同じ終了のダイアログ（SprintCloseDialog）を開く。
  // 終えたら一覧を読み直し、押した「終える」が消えるので見出しへフォーカスを移す
  let { data }: PageProps = $props();

  const workspace = $derived(data.workspace);
  const plan = $derived(data.plan);
  const summary = $derived(data.summary);
  const slug = $derived(page.params.slug ?? '');
  const isAdmin = $derived(data.organization?.me.is_admin === true);
  // 作る、直す、削除するのは、終了していないワークスペースのリーダーと管理者だけ（API も同じ権限で断る）
  const isLeader = $derived(workspace !== null && (workspace.role === 'leader' || isAdmin));
  const isClosed = $derived(workspace !== null && workspace.closedAt !== null);
  const canLead = $derived(isLeader && !isClosed);
  // 入れる、外すのはメンバー（この画面を開ける人）。終了したワークスペースでは出さない
  const canWrite = $derived(workspace !== null && !isClosed);
  const sprintWords = $derived({
    sprint: t('sprint'),
    task: t('task'),
    points: t('points'),
    capacity: t('capacity'),
    leader: t('leader'),
  });
  // 空の状態の説明。終了したワークスペース、リーダー、リーダーでない人で、辞書の項目ごと分ける（文をつながない）
  const emptyText = $derived(
    isClosed
      ? t('sprintEmptyClosedText', { sprint: t('sprint'), workspace: t('workspace') })
      : isLeader
        ? t('sprintEmptyText', sprintWords)
        : t('sprintEmptyMemberText', sprintWords),
  );
  // ベロシティ（延長していない終了した直近 3 つの平均）。出ていなければ null
  const average = $derived(summary?.velocity.average ?? null);
  const lanes = $derived(new Map((summary?.lanes ?? []).map((lane) => [lane.sprint_id, lane])));
  // 見出しの集計。ベロシティが出ていなければ、その項目は出さない（偽の 0 を出さない）
  const tallies = $derived.by<Tally[]>(() => {
    if (summary === null) return [];
    const list = [...lanes.values()];
    const result: Tally[] = [];
    if (average !== null) {
      result.push({
        icon: 'trend',
        label: t('planTallyVelocity', { velocity: t('velocity') }),
        count: Number(formatPoints(average)),
      });
    }
    result.push({
      tone: 'danger',
      icon: 'alert',
      label: t('over'),
      count: list.filter((lane) => isOverVelocity(lane.points, average)).length,
    });
    result.push({
      tone: 'warn',
      label: t('planTallyUnestimated'),
      count: list.reduce((total, lane) => total + lane.unestimated_count, 0),
    });
    return result;
  });
  // 先のスプリントも、終了したスプリント（ベロシティの元）も無い
  const isBlank = $derived(
    plan !== null && plan.sprints.length === 0 && (summary === null || summary.velocity.sprints.length === 0),
  );
  // 行のタイトルは、この画面に `?task=<ID>` を付けて詳細の引き出しを開く（ワークスペースの枠が置く）
  const planHref = $derived(resolve('/[slug]/w/[id]/plan', { slug: page.params.slug ?? '', id: page.params.id ?? '' }));

  let sprintDialog = $state<ReturnType<typeof SprintDialog>>();
  let startDialog = $state<ReturnType<typeof SprintStartDialog>>();
  let closeDialog = $state<ReturnType<typeof SprintCloseDialog>>();
  let taskPicker = $state<ReturnType<typeof SprintTaskPicker>>();
  let confirmDelete = $state<ReturnType<typeof ConfirmDialog>>();
  // 削除の確かめに出すスプリントと、削除を送っている最中か
  let deleteTarget = $state<SprintSummary | null>(null);
  let deleting = $state(false);
  // 外すのを送っている最中のタスク
  let removingId = $state<string | null>(null);

  function labelOf(sprint: SprintSummary): string {
    return sprintLabel(sprint, t);
  }

  function periodOf(sprint: SprintSummary): string {
    return sprintPeriod(sprint, t);
  }

  function pointsOf(sprint: SprintPlan): number {
    return sprint.tasks.reduce((total, task) => total + (task.points ?? 0), 0);
  }

  async function reload(): Promise<void> {
    await invalidate('app:sprints');
  }

  // 始めたら、押した「始める」が一覧から消えるので、始めたスプリントの見出しへフォーカスを移す（無ければ画面の見出し）
  async function started(sprintId: string): Promise<void> {
    await reload();
    await tick();
    const title = document.querySelector<HTMLElement>(`[data-lane-title="${CSS.escape(sprintId)}"]`);
    if (title) title.focus();
    else focusPageHeading();
  }

  function openCreate(event: MouseEvent): void {
    if (plan === null) return;
    sprintDialog?.show(event.currentTarget as HTMLElement, null, plan.defaults);
  }

  function openEdit(event: MouseEvent, sprint: SprintSummary): void {
    if (plan === null) return;
    sprintDialog?.show(event.currentTarget as HTMLElement, sprint, plan.defaults);
  }

  // 進行中のスプリントが別にあれば、始めるダイアログが理由を出して「始める」を押せなくする
  function openStart(event: MouseEvent, sprint: SprintPlan): void {
    if (plan === null) return;
    startDialog?.show(
      event.currentTarget as HTMLElement,
      sprint,
      plan.sprints.some((other) => other.status === 'active'),
    );
  }

  // 日付は YYYY-MM-DD なので、文字列の比較が日付の前後と一致する。終了したワークスペースでは、誰も終えられないので促さない
  function isOverdue(sprint: SprintSummary): boolean {
    return plan !== null && !isClosed && sprint.status === 'active' && plan.today > sprint.end_on;
  }

  // 終えたら、押した「終える」が消えるので、一覧を読み直して見出しへフォーカスを移す
  async function closed(): Promise<void> {
    await reload();
    await tick();
    focusPageHeading();
  }

  function openPicker(event: MouseEvent, sprint: SprintSummary): void {
    taskPicker?.show(event.currentTarget as HTMLElement, sprint);
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
        window.location.assign(loginUrl(page.url, result));
        return;
      }
      const words = { sprint: t('sprint'), workspace: t('workspace'), leader: t('leader') };
      if (result.ok) showToast(t('sprintDeleted', words), 'check');
      else if (result.error?.code === 'workspace_closed') {
        showToast(t('workspaceClosedReadOnly', words), 'alert');
        await invalidate('app:workspace');
      } else if (result.error?.code === 'conflict' && sprintConflictReasonOf(result.error.details) === 'started') {
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
    focusPageHeading();
  }

  // スプリントから外す。確かめのダイアログは挟まない（もう一度入れられるため）。1本ずつ送る
  async function removeTask(sprint: SprintSummary, task: SprintTask): Promise<void> {
    if (removingId !== null || workspace === null) return;
    removingId = task.id;
    try {
      const result = await callOperation(
        sprintTaskRemove,
        { workspace_id: workspace.id, sprint_id: sprint.id, task_id: task.id },
        { slug },
      );
      if (!result.ok && isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url, result));
        return;
      }
      const words = { sprint: t('sprint'), task: t('task'), done: t('done'), workspace: t('workspace') };
      const reason = result.ok ? undefined : sprintTaskConflictReasonOf(result.error?.details);
      if (result.ok) showToast(t('sprintTaskRemoved', { title: task.title }), 'check');
      else if (result.error?.code === 'workspace_closed') {
        showToast(t('workspaceClosedReadOnly', words), 'alert');
        await invalidate('app:workspace');
      } else if (reason === 'completed') showToast(t('sprintTaskRemoveCompleted', words), 'alert');
      else if (reason === 'closed') showToast(t('sprintTaskClosed', words), 'alert');
      else if (result.status === 404) showToast(t('sprintTaskRemoveGone', words), 'alert');
      else if (result.status === 403) {
        showToast(t('sprintTaskRemoveFailed'), 'alert');
        await invalidate('app:workspace');
      } else showToast(t('sprintTaskRemoveFailed'), 'alert');
      await reload();
    } finally {
      removingId = null;
    }
    await tick();
    const add = document.querySelector<HTMLElement>(`[data-sprint-add="${CSS.escape(sprint.id)}"]`);
    if (add) add.focus();
    else focusPageHeading();
  }
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
  <PageHead title={t('plan')} eyebrow={workspace.name} tallies={isBlank ? [] : tallies} focusable>
    {#snippet actions()}
      {#if canLead}
        <button class="btn is-primary" type="button" onclick={openCreate}
          ><Icon name="plus" />{t('sprintCreate', sprintWords)}</button
        >
      {/if}
    {/snippet}
  </PageHead>

  <!-- 読み上げの領域。常に置き、文字だけを替える -->
  <div class="visually-hidden" role="status">
    {deleting ? t('sprintDeleting') : removingId !== null ? t('sprintTaskRemoving') : ''}
  </div>

  {#if isBlank}
    <EmptyState icon="calendar" title={t('sprintEmptyTitle', sprintWords)} text={emptyText} />
  {:else}
    {#if summary !== null}
      <PlanVelocity velocity={summary.velocity} />
    {:else}
      <div class="callout is-warn" role="alert">
        <Icon name="alert" />
        <span>{t('planSummaryFailed', { velocity: t('velocity'), epic: t('epic') })}</span>
        <div class="callout-actions">
          <button class="btn is-sm" type="button" onclick={() => void reload()}>{t('retry')}</button>
        </div>
      </div>
    {/if}
    {#if plan.sprints.length === 0}
      <EmptyState icon="calendar" title={t('sprintEmptyTitle', sprintWords)} text={emptyText} />
    {:else}
      <div class="lanes">
        {#each plan.sprints as sprint (sprint.id)}
          {@const lane = lanes.get(sprint.id)}
          <section class="lane" class:is-active={sprint.status === 'active'}>
            <div class="lane-head">
              <!-- tabindex="-1" は、始めた後にプログラムからフォーカスを置くため（キーボードの Tab 順には入らない） -->
              <h2 class="lane-title" tabindex="-1" data-lane-title={sprint.id}>{labelOf(sprint)}</h2>
              {#if sprint.status === 'active'}<span class="chip is-ok">{t('sprintActive')}</span>{/if}
            </div>
            <div class="lane-sub">
              <span class="mono">{periodOf(sprint)}</span>
              <span>{t('sprintLengthDays', { length: sprint.length })}</span>
              {#if sprint.extended_days > 0}<span>{t('sprintExtended', { days: sprint.extended_days })}</span>{/if}
              <span>{t('sprintTasksSummary', { count: sprint.tasks.length, points: pointsOf(sprint) })}</span>
              {#if lane !== undefined && lane.unestimated_count > 0}
                <span data-lane-unestimated>{t('planUnestimated', { count: lane.unestimated_count })}</span>
              {/if}
            </div>
            {#if isOverdue(sprint)}
              <SprintOverdueNotice
                {sprint}
                canClose={canLead}
                onclose={(trigger) => closeDialog?.show(trigger, sprint)}
              />
            {/if}
            {#if sprint.status === 'active' && sprint.goal !== null}
              <p class="lane-goal"><span class="lane-goal-label">{t('sprintGoal')}</span>{sprint.goal}</p>
            {/if}
            {#if lane !== undefined}
              <PlanLaneFill points={lane.points} {average} />
            {/if}
            {#each sprint.tasks as task (task.id)}
              <div class="lane-row" class:is-done={task.completed_at !== null} data-row-id={task.id}>
                {#if task.points === null}
                  <span class="pts is-none" role="img" aria-label={t('pointsUnsetTitle')} title={t('pointsUnsetTitle')}
                    >{t('pointsUnsetMark')}</span
                  >
                {:else}
                  <span
                    class="pts"
                    role="img"
                    aria-label={t('pointsLabel', { points: t('points'), value: task.points })}
                    title={t('pointsLabel', { points: t('points'), value: task.points })}>{task.points}</span
                  >
                {/if}
                <!-- 押しても、フォーカスとスクロールの位置は動かさない（引き出しが閉じたとき、data-task-id で探してフォーカスを戻す） -->
                <a
                  href="{planHref}?task={encodeURIComponent(task.id)}"
                  data-task-id={task.id}
                  data-sveltekit-reset="false">{task.title}</a
                >
                <span class="lane-row-end">
                  {#if task.completed_at !== null}
                    <!-- 完了の印（バックログの木の行と同じ .hanko）。担当の左に置き、担当の位置をそろえる -->
                    <span
                      class="hanko"
                      role="img"
                      aria-label={t('doneMarkLabel', { title: task.title, done: t('done') })}
                      ><Icon name="check" /><b>{t('doneStamp')}</b></span
                    >
                  {/if}
                  {#if task.assignee === null}
                    <Avatar userId={null} />
                  {:else}
                    <Avatar userId={task.assignee.id} name={task.assignee.name} />
                  {/if}
                  {#if canWrite && task.completed_at === null}
                    <button
                      class="icon-btn"
                      type="button"
                      aria-label={t('sprintTaskRemoveLabel', { title: task.title })}
                      title={t('sprintTaskRemove')}
                      aria-disabled={removingId !== null}
                      onclick={() => void removeTask(sprint, task)}><Icon name="x" /></button
                    >
                  {:else if canWrite}
                    <!-- 外す口の無い行（完了したタスク）も、同じ幅を空けて担当の位置をそろえる -->
                    <span class="lane-row-slot" aria-hidden="true"></span>
                  {/if}
                </span>
              </div>
            {:else}
              <p class="action-note">{t('sprintTasksEmpty')}</p>
            {/each}
            {#if canWrite}
              <button
                class="btn is-sm"
                type="button"
                data-sprint-add={sprint.id}
                aria-label={t('sprintTaskAddOpenLabel', { backlog: t('backlog'), label: labelOf(sprint) })}
                onclick={(event) => openPicker(event, sprint)}
                ><Icon name="plus" />{t('sprintTaskAddOpen', { backlog: t('backlog') })}</button
              >
            {/if}
            {#if canLead && sprint.status === 'planned'}
              <div class="form-actions">
                <button
                  class="btn is-sm is-primary"
                  type="button"
                  aria-label={t('sprintStartLabel', { label: labelOf(sprint) })}
                  aria-disabled={deleting}
                  onclick={(event) => !deleting && openStart(event, sprint)}
                  ><Icon name="play" />{t('sprintStartAction')}</button
                >
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
    {#if summary !== null}
      <PlanEpics
        epics={summary.epics}
        {slug}
        workspaceId={workspace.id}
        today={summary.today}
        weekStart={summary.week_start}
      />
    {/if}
  {/if}

  {#key workspace.id}
    <SprintDialog bind:this={sprintDialog} {slug} workspaceId={workspace.id} onsaved={reload} ongone={reload} />
    <SprintStartDialog bind:this={startDialog} {slug} workspaceId={workspace.id} onstarted={started} ongone={reload} />
    <SprintCloseDialog
      bind:this={closeDialog}
      {slug}
      workspaceId={workspace.id}
      onclosed={() => void closed()}
      ongone={reload}
    />
    <SprintTaskPicker bind:this={taskPicker} {slug} workspaceId={workspace.id} onadded={reload} />
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
