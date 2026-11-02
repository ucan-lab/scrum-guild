<script lang="ts">
  import { tick } from 'svelte';
  import { invalidate } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { callOperation, type ApiResult } from '../../lib/api.ts';
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import FirstSteps from '../../lib/components/FirstSteps.svelte';
  import Icon from '../../lib/components/Icon.svelte';
  import LevelPanel from '../../lib/components/LevelPanel.svelte';
  import LoadFailed from '../../lib/components/LoadFailed.svelte';
  import PageHead, { type Tally } from '../../lib/components/PageHead.svelte';
  import Section from '../../lib/components/Section.svelte';
  import SprintGoalNotice from '../../lib/components/SprintGoalNotice.svelte';
  import TaskEntry from '../../lib/components/TaskEntry.svelte';
  import WorkspaceCreateDialog from '../../lib/components/WorkspaceCreateDialog.svelte';
  import { completedMessage } from '../../lib/sprint-label.ts';
  import { showToast } from '../../lib/toast.svelte.ts';
  import { todaySections } from '../../lib/today-sections.ts';
  import { t } from '../../lib/vocabulary.svelte.ts';
  import type { TodayTask } from '../../shared/operations/organization/today.ts';
  import type { BacklogTask } from '../../shared/operations/task/backlog-tree.ts';
  import {
    taskComplete,
    taskReopen,
    taskReopenConflictReasonOf,
    taskTodayMark,
    taskTodayMarkConflictReasonOf,
  } from '../../shared/operations/task/index.ts';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
  let createDialog = $state<ReturnType<typeof WorkspaceCreateDialog>>();
  // 管理者でワークスペースが無い、または所属が無いときの案内。ほかは 'default'
  const emptyKind = $derived.by(() => {
    const view = data.organization;
    if (view === null || !view.me.is_admin) return 'default';
    if (!view.organization.has_workspaces) return 'firstWorkspace';
    return view.workspaces.length === 0 ? 'noMembership' : 'default';
  });
  // 次にやることのボタンの行き先（所属する最初のワークスペースのバックログ）
  const firstWorkspace = $derived(data.organization?.workspaces[0] ?? null);
  // today の読み込みの失敗（data.today が null）は、空の一覧と区別して失敗の画面を出す
  const sections = $derived(todaySections(data.today?.tasks ?? []));
  const tallies = $derived<Tally[]>([
    { icon: 'sun', label: t('sectionToday'), count: sections.today.length },
    { tone: 'danger', icon: 'alert', label: t('overdue'), count: sections.overdue.length },
    { tone: 'warn', icon: 'clock', label: t('weekDue'), count: sections.week.length },
    { icon: 'check', label: t('doneToday'), count: sections.done.length },
  ]);

  function taskOf(task: TodayTask): BacklogTask {
    return {
      id: task.id,
      title: task.title,
      points: task.points,
      due_on: task.due_on,
      assignee: task.assignee,
      category: null,
      repository: task.repository,
      sprint: task.sprint,
      // 今日やることの行には未記入の印を出さない（決まった欄の未記入は、バックログの木と引き出しと計画の画面に出す）
      unfilled: false,
    };
  }

  // 今日やることは、閉じていないワークスペースの、本人が担当するタスクだけを読む。行はどれも本人が書き込める行なので、
  // 太陽（印の付け外し）、完了、戻すは全部の行に出す（戻すは、サーバーが reopenable と答えた今日完了の行だけ）。
  // 操作を送っている行（pendingIds）は、ほかの操作も押しても無視する。通ったら今日の読み取りを読み直す（経験値の列も同じ load で読み直す）。
  // 失敗は理由をトーストで知らせ、断られた（404、409）ときは読み直して今の区分に移す。ログインが切れた（401）ときは、読み直すと load がログインの画面へ移す
  let pendingIds = $state<string[]>([]);
  // 今この画面で完了にした行。判を押す動き（.is-new）はこの行だけで再生する
  let justDoneIds = $state<string[]>([]);

  // notice は、すぐ出す知らせ。読み直した後の今日の読み取りを見て決めるときは、読み直しの後に呼ぶ関数にする
  type Notice = { message: string; icon: 'check' | 'alert' };
  type Outcome = { notice: Notice | (() => Notice); reload: boolean; focus: string };
  const notify = (message: string, icon: Notice['icon']): Notice => ({ message, icon });

  // 読み直した後、同じ行の操作（selector）へフォーカスを戻す。行が無いか、フォーカスが行の中に入らなかったとき
  // （畳んだ区分の中など）は見出しへ
  async function focusRow(taskId: string, selector: string): Promise<void> {
    await tick();
    const row = [...document.querySelectorAll<HTMLElement>('[data-row-id]')].find((el) => el.dataset.rowId === taskId);
    row?.querySelector<HTMLElement>(selector)?.focus();
    if (row === undefined || !row.contains(document.activeElement)) {
      document.querySelector<HTMLElement>('h1.page-title')?.focus();
    }
  }

  // 1つの操作を送る。outcomeOf が null を返すのはログインが切れたとき（読み直して、load にログインの画面へ移してもらう）
  async function perform<T>(
    task: TodayTask,
    call: () => Promise<ApiResult<T>>,
    outcomeOf: (result: ApiResult<T>) => Outcome | null,
  ): Promise<void> {
    if (pendingIds.includes(task.id)) return;
    pendingIds = [...pendingIds, task.id];
    try {
      const result = await call();
      const outcome = outcomeOf(result);
      if (outcome === null) {
        await invalidate('app:today');
        return;
      }
      const deferred = typeof outcome.notice === 'function' ? outcome.notice : undefined;
      if (typeof outcome.notice !== 'function') showToast(outcome.notice.message, outcome.notice.icon);
      // 読み直しの失敗は、load が today を null にして答える（invalidate は reject しない）。知らせは、そのとき残った読み取りで決める
      if (outcome.reload) await invalidate('app:today');
      if (deferred !== undefined) {
        await tick();
        const notice = deferred();
        showToast(notice.message, notice.icon);
      }
      await focusRow(task.id, outcome.focus);
    } finally {
      pendingIds = pendingIds.filter((id) => id !== task.id);
    }
  }

  // 404 と、閉じたワークスペースの 409 は、どの操作でも同じ知らせにして読み直す
  function gone(result: { status: number; error: { code: string } | null }, focus: string): Outcome | null {
    if (result.status === 404)
      return { notice: notify(t('taskGone', { task: t('task') }), 'alert'), reload: true, focus };
    if (result.status === 409 && result.error?.code === 'workspace_closed') {
      return {
        notice: notify(t('workspaceClosedReadOnly', { workspace: t('workspace') }), 'alert'),
        reload: true,
        focus,
      };
    }
    return null;
  }

  function toggleToday(task: TodayTask): Promise<void> {
    const marked = task.today_on === null;
    return perform(
      task,
      () =>
        callOperation(
          taskTodayMark,
          { workspace_id: task.workspace_id, task_id: task.id, marked },
          { slug: data.slug },
        ),
      (result) => {
        const focus = '.sun';
        if (result.ok) {
          return { notice: notify(t(marked ? 'todayMarked' : 'todayUnmarked'), 'check'), reload: true, focus };
        }
        if (result.status === 401) return null;
        const refused = gone(result, focus);
        if (refused !== null) return refused;
        if (result.status === 409) {
          const reason = taskTodayMarkConflictReasonOf(result.error?.details);
          const message =
            reason === 'not_assignee'
              ? t('todayMarkNotAssignee', { assignee: t('assignee') })
              : reason === 'completed'
                ? t('todayMarkDone', { task: t('task'), done: t('done') })
                : t('todayMarkFailed');
          return { notice: notify(message, 'alert'), reload: true, focus };
        }
        return { notice: notify(t('todayMarkFailed'), 'alert'), reload: false, focus };
      },
    );
  }

  function complete(task: TodayTask): Promise<void> {
    return perform(
      task,
      () => callOperation(taskComplete, { workspace_id: task.workspace_id, task_id: task.id }, { slug: data.slug }),
      (result) => {
        // 完了にした行は今日完了の区分に移り、完了の印（tabindex="-1"）にフォーカスを移す
        const focus = '.hanko';
        if (result.ok) {
          if (!justDoneIds.includes(task.id)) justDoneIds = [...justDoneIds, task.id];
          return { notice: notify(completedMessage(result.data.left_sprint, t), 'check'), reload: true, focus };
        }
        if (result.status === 401) return null;
        const refused = gone(result, focus);
        if (refused !== null) return refused;
        // 409 の conflict は、別の画面で先に完了にされたか、競合でやり直しきれなかったか。読み直して、完了していた行は「すでに完了」、
        // 行が読み取りから外れていた（日付をまたいだ、担当替え、削除）ときは「見つからない」、未完了のまま残ったときは失敗として知らせる
        if (result.status === 409 && result.error?.code === 'conflict') {
          return {
            reload: true,
            // 完了していれば完了の印へ、していなければ完了のボタンへ
            focus: '.hanko, .done-btn',
            notice: () => {
              // 読み直しに失敗した（today が null）ときは、行が消えたとは言えないので、失敗の知らせにする
              if (data.today === null) return notify(t('taskCompleteFailed', { done: t('done') }), 'alert');
              const entry = data.today.tasks.find((candidate) => candidate.id === task.id);
              if (entry === undefined) return notify(t('taskGone', { task: t('task') }), 'alert');
              return entry.completed_at !== null
                ? notify(t('taskAlreadyDone', { task: t('task'), done: t('done') }), 'check')
                : notify(t('taskCompleteFailed', { done: t('done') }), 'alert');
            },
          };
        }
        return { notice: notify(t('taskCompleteFailed', { done: t('done') }), 'alert'), reload: false, focus };
      },
    );
  }

  // 戻せなかった理由（TaskDrawer の「戻す」と同じ文）
  function reopenFailureMessage(details: unknown): string {
    const words = { task: t('task'), done: t('done'), sprint: t('sprint'), story: t('story') };
    switch (taskReopenConflictReasonOf(details)) {
      case 'not_completed':
        return t('taskReopenNotDone', words);
      case 'sprint_closed':
        return t('taskReopenSprintClosed', words);
      case 'parent_completed':
        return t('taskReopenParentDone', words);
      default:
        return t('taskReopenChanged');
    }
  }

  function reopen(task: TodayTask): Promise<void> {
    return perform(
      task,
      () => callOperation(taskReopen, { workspace_id: task.workspace_id, task_id: task.id }, { slug: data.slug }),
      (result) => {
        // 戻した行は完了の前の区分に移り、完了のボタンにフォーカスを移す。戻せなかったときは、今日完了の区分の完了の印に残す
        if (result.ok) {
          justDoneIds = justDoneIds.filter((id) => id !== task.id);
          return {
            notice: notify(t('taskReopened', { task: t('task'), done: t('done') }), 'check'),
            reload: true,
            focus: '.done-btn',
          };
        }
        if (result.status === 401) return null;
        const refused = gone(result, '.hanko');
        if (refused !== null) return refused;
        if (result.status === 409) {
          return {
            notice: notify(reopenFailureMessage(result.error?.details), 'alert'),
            reload: true,
            focus: '.hanko',
          };
        }
        return { notice: notify(t('taskReopenFailed', { done: t('done') }), 'alert'), reload: false, focus: '.hanko' };
      },
    );
  }
</script>

{#snippet rows(list: TodayTask[], options: { done?: boolean; markDueToday?: boolean } = {})}
  <div class="book">
    {#each list as task (task.id)}<TaskEntry
        task={taskOf(task)}
        done={options.done ?? false}
        justDone={justDoneIds.includes(task.id)}
        pending={pendingIds.includes(task.id)}
        onComplete={() => void complete(task)}
        marked={task.today_on !== null}
        onToggleToday={() => void toggleToday(task)}
        onReopen={options.done && task.reopenable ? () => void reopen(task) : undefined}
        clock={{ today: task.today, weekStart: task.week_start }}
        workspaceId={task.workspace_id}
        workspaceName={task.workspace_name}
        metaChip={options.markDueToday && task.due_on === task.today ? t('dueIsToday') : undefined}
        metaText={task.carry_days > 0 ? t('carryDays', { days: task.carry_days }) : undefined}
      />{/each}
  </div>
{/snippet}

{#snippet todayEmpty()}
  {#if emptyKind === 'firstWorkspace'}
    <EmptyState
      icon="sun"
      art="map"
      title={t('firstWorkspaceTitle', { workspace: t('workspace') })}
      text={t('firstWorkspaceText', { workspace: t('workspace'), leader: t('leader') })}
    >
      {#snippet actions()}<button
          class="btn is-sm"
          type="button"
          onclick={(event) => createDialog?.show(event.currentTarget)}
          ><Icon name="plus" />{t('workspaceCreateAction', { workspace: t('workspace') })}</button
        >{/snippet}
    </EmptyState>
  {:else if emptyKind === 'noMembership'}
    <EmptyState
      icon="sun"
      art="notice"
      title={t('noMembershipTitle', { workspace: t('workspace') })}
      text={t('noMembershipText', { workspace: t('workspace') })}
    />
  {:else if firstWorkspace !== null}
    <EmptyState
      icon="sun"
      art="notice"
      title={t('todayEmptyTitle', { task: t('task') })}
      text={t('todayEmptyText', { assignee: t('assignee'), task: t('task'), backlog: t('backlog') })}
    >
      {#snippet actions()}<a
          class="btn is-sm"
          href={resolve('/[slug]/w/[id]', { slug: data.slug, id: firstWorkspace.id })}
          >{t('todayEmptyAction', { backlog: t('backlog') })}</a
        >{/snippet}
    </EmptyState>
  {:else}
    <EmptyState
      icon="sun"
      art="notice"
      title={t('todayEmptyTitle', { task: t('task') })}
      text={t('todayEmptyNoWorkspaceText', { workspace: t('workspace'), assignee: t('assignee'), task: t('task') })}
    />
  {/if}
{/snippet}

{#snippet main()}
  <!-- 最初にやること。手順が空（必須が済んだ、出す手順が無い）か読めなかったときは置かない -->
  {#if data.firstSteps !== null && data.firstSteps.role !== null && data.firstSteps.steps.length > 0 && (data.firstSteps.role !== 'admin' || data.organization?.me.is_admin)}
    <FirstSteps
      slug={data.slug}
      role={data.firstSteps.role}
      steps={data.firstSteps.steps}
      organizationName={data.organization?.organization.name ?? ''}
      onCreateWorkspace={data.organization?.me.is_admin ? (opener) => createDialog?.show(opener) : undefined}
    />
  {/if}
  {#if data.today !== null && data.today.sprint_goals.length > 0}
    <div class="notice-grid">
      {#each data.today.sprint_goals as sprint (sprint.workspace_id)}
        <SprintGoalNotice goal={sprint.goal} workspaceName={sprint.workspace_name} />
      {/each}
    </div>
  {/if}
  {#if sections.overdue.length > 0}
    <Section id="s-overdue" title={t('overdue')} count={sections.overdue.length}>
      {@render rows(sections.overdue)}
    </Section>
  {/if}
  <Section id="s-today" title={t('sectionToday')} count={sections.today.length} hint={t('sectionTodayHint')}>
    {#if sections.today.length === 0}
      {@render todayEmpty()}
    {:else}
      {@render rows(sections.today)}
    {/if}
  </Section>
  {#if sections.week.length > 0}
    <Section id="s-week" title={t('weekDue')} count={sections.week.length}>
      {@render rows(sections.week, { markDueToday: true })}
    </Section>
  {/if}
  {#if sections.sprint.length > 0}
    <Section id="s-sprint" title={t('sprintInProgress')} count={sections.sprint.length} folded>
      {@render rows(sections.sprint)}
    </Section>
  {/if}
  {#if sections.done.length > 0}
    <Section id="s-done" title={t('doneToday')} count={sections.done.length}>
      {@render rows(sections.done, { done: true })}
    </Section>
  {/if}
{/snippet}

<!-- 読み込みに失敗したときの題名は LoadFailed が持つ -->
<svelte:head>
  {#if data.today !== null}<title>{t('pageTitle', { page: t('pageToday'), app: t('appName') })}</title>{/if}
</svelte:head>
{#if data.today === null}
  <LoadFailed inShell />
{:else}
  <PageHead title={t('pageToday')} {tallies} focusable />
  {#if data.experience}
    <div class="layout-aside">
      <div class="layout-main">{@render main()}</div>
      <aside class="layout-side" aria-label={t('myRecord')}>
        <LevelPanel
          total={data.experience.total}
          prospective={data.experience.prospective}
          thanksReceived={data.experience.thanks_received}
          workspaces={data.experience.workspaces}
        />
      </aside>
    </div>
  {:else}
    <!-- 経験値を読めなかったときは右の列ごと省く（列の幅だけ空けない） -->
    <div class="layout-main">{@render main()}</div>
  {/if}
  {#if data.organization?.me.is_admin}<WorkspaceCreateDialog
      bind:this={createDialog}
      slug={data.slug}
      meId={data.organization.me.id}
    />{/if}
{/if}
