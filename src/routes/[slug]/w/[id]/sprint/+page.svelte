<script lang="ts">
  import { tick } from 'svelte';
  import { invalidate, invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { callOperation, type ApiResult } from '../../../../../lib/api.ts';
  import EmptyState from '../../../../../lib/components/EmptyState.svelte';
  import Icon from '../../../../../lib/components/Icon.svelte';
  import LoadFailed from '../../../../../lib/components/LoadFailed.svelte';
  import PageHead from '../../../../../lib/components/PageHead.svelte';
  import SprintCard from '../../../../../lib/components/SprintCard.svelte';
  import { MoveQueue } from '../../../../../lib/move-queue.ts';
  import { edgesOf, planCardMove, type MoveDirection, type MoveEdge } from '../../../../../lib/sprint-board.ts';
  import { completedMessage, sprintLabel, sprintPeriod } from '../../../../../lib/sprint-label.ts';
  import { showToast } from '../../../../../lib/toast.svelte.ts';
  import { t } from '../../../../../lib/vocabulary.svelte.ts';
  import {
    columnMoveConflictReasonOf,
    taskColumnMove,
    type SprintBoardColumn,
    type SprintBoardTask,
  } from '../../../../../shared/operations/sprint/index.ts';
  import { taskComplete } from '../../../../../shared/operations/task/index.ts';
  import { sprintProgress } from '../../../../../shared/sprint.ts';
  import type { PageProps } from './$types';

  // スプリントの画面（design/sprint.html）。進行中のスプリントの列（`.board-col`）とカード（`.card`）を並べる。
  // 見出しは進行中のスプリントの名前（無ければ期間）、小見出しは期間と何日目か。ゴールを書いて始めていれば貼り紙（`.notice`）で出す。
  // カードは題（`?task=<ID>` で詳細の引き出しを開く）、親のストーリー、ポイント、担当と、完了の印か完了の操作。
  // 完了の操作は task-complete を呼ぶだけで、完了の列への移動は task-complete が行う（完了の列へ task-column-move で移すことはしない）。
  // 動かせるカード（完了していない、終了していないワークスペース）は、選んで Alt と ← → で隣の列、Alt と ↑ ↓ で列の中を動かし、
  // カードの下のボタンでも同じことができる。動かしたら先に画面の並びを替えて位置を読み上げ、押した順に1つずつ送る（MoveQueue）。
  // 断られたら理由をトーストで知らせて読み直す。ドラッグは #245 で足す。
  // 進行中のスプリントが無いときは、見本の空の状態をロールで文を分けて出す
  let { data }: PageProps = $props();

  const workspace = $derived(data.workspace);
  const board = $derived(data.board);
  const slug = $derived(page.params.slug ?? '');
  const isAdmin = $derived(data.organization?.me.is_admin === true);
  const isLeader = $derived(workspace !== null && (workspace.role === 'leader' || isAdmin));
  const isClosed = $derived(workspace !== null && workspace.closedAt !== null);
  const canWrite = $derived(workspace !== null && !isClosed);
  const sprint = $derived(board?.sprint ?? null);
  const sprintHref = $derived(
    resolve('/[slug]/w/[id]/sprint', { slug: page.params.slug ?? '', id: page.params.id ?? '' }),
  );
  const planHref = $derived(resolve('/[slug]/w/[id]/plan', { slug: page.params.slug ?? '', id: page.params.id ?? '' }));
  const backlogHref = $derived(resolve('/[slug]/w/[id]', { slug: page.params.slug ?? '', id: page.params.id ?? '' }));

  // 画面で動かした後の列とカード。読み直したら捨てる
  let local = $state<SprintBoardColumn[] | null>(null);
  const columns = $derived(local ?? board?.columns ?? []);
  const moves = new MoveQueue<ApiResult<unknown>>({
    reload: reloadBoard,
    dropped: () => showToast(t('moveReloaded'), 'alert'),
  });
  $effect.pre(() => {
    void board;
    local = null;
    moves.reloaded();
  });

  // 動かした結果の読み上げ。領域は常に置き、中の文字だけを替える。同じ文が続いても読まれるよう、一度空にしてから入れる
  let status = $state('');
  async function announce(message: string): Promise<void> {
    status = '';
    await tick();
    status = message;
  }

  let completingId = $state<string | null>(null);

  function columnName(column: SprintBoardColumn): string {
    return column.is_done ? t('done') : (column.name ?? '');
  }

  function pointsOf(tasks: readonly SprintBoardTask[]): number {
    return tasks.reduce((total, task) => total + (task.points ?? 0), 0);
  }

  const allTasks = $derived(columns.flatMap((column) => column.tasks));
  const progress = $derived(sprint !== null && board !== null ? sprintProgress(sprint, board.today) : null);
  const doneColumnTasks = $derived(columns.filter((column) => column.is_done).flatMap((column) => column.tasks));
  const tallies = $derived([
    { icon: 'check' as const, label: t('sprintBoardTallyDone', { done: t('done') }), count: pointsOf(doneColumnTasks) },
    { label: t('sprintBoardTallyTotal'), count: pointsOf(allTasks) },
    { icon: 'clock' as const, label: t('sprintBoardTallyRemaining'), count: progress?.remaining ?? 0 },
  ]);

  async function reloadBoard(): Promise<void> {
    const saved = savedFocus();
    try {
      await invalidate('app:sprint-board');
    } finally {
      local = null;
    }
    await restoreFocus(saved);
  }

  // フォーカスのあるカード（data-card-id）と、その中で何番目の操作か（-1 はカードそのもの）。並べ替えや読み直しでカードの要素が
  // 作り直されても、同じカードの同じ操作へフォーカスを戻す
  function savedFocus(): { id: string; index: number } | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    const card = active.closest<HTMLElement>('[data-card-id]');
    if (card === null) return null;
    const index = active === card ? -1 : [...card.querySelectorAll<HTMLElement>('a, button')].indexOf(active);
    return { id: card.dataset.cardId ?? '', index };
  }

  async function restoreFocus(saved: { id: string; index: number } | null): Promise<void> {
    if (saved === null) return;
    await tick();
    const card = [...document.querySelectorAll<HTMLElement>('[data-card-id]')].find(
      (el) => el.dataset.cardId === saved.id,
    );
    if (card === undefined) return;
    const control = saved.index === -1 ? card : card.querySelectorAll<HTMLElement>('a, button')[saved.index];
    (control ?? card).focus();
  }

  function edgeMessage(edge: MoveEdge): string {
    if (edge === 'top') return t('moveAtTop');
    if (edge === 'bottom') return t('moveAtBottom');
    if (edge === 'prev') return t('sprintCardNoPrevColumn', { column: t('column') });
    return t('sprintCardNoNextColumn', { done: t('done'), column: t('column'), complete: t('complete') });
  }

  // 断られた移動の理由。409 の conflict は、サーバーが details.reason に載せた理由で分ける
  function moveFailureMessage(result: { status: number; error: { code: string; details?: unknown } | null }): string {
    if (result.status === 404) return t('sprintCardMoveGone', { task: t('task'), column: t('column') });
    if (result.status === 409 && result.error?.code === 'workspace_closed') {
      return t('workspaceClosedReadOnly', { workspace: t('workspace') });
    }
    if (result.status === 409) {
      switch (columnMoveConflictReasonOf(result.error?.details)) {
        case 'done_column':
          return t('sprintCardMoveDoneColumn', { done: t('done'), column: t('column') });
        case 'task_completed':
          return t('moveTaskDone', { task: t('task'), done: t('done') });
        case 'not_active':
          return t('sprintCardMoveNotActive', { sprint: t('sprint') });
        case 'changed':
          return t('moveConflict');
        default:
          return t('sprintCardMoveFailed');
      }
    }
    return t('sprintCardMoveFailed');
  }

  function moveCard(task: SprintBoardTask, direction: MoveDirection): void {
    if (workspace === null || !canWrite) return;
    const plan = planCardMove(columns, task.id, direction);
    if (plan === null) return;
    // 端で押したときは、動かせないことを読み上げる
    if (plan.kind === 'edge') {
      void announce(edgeMessage(plan.edge));
      return;
    }
    const saved = savedFocus();
    local = plan.columns;
    void restoreFocus(saved);
    void announce(
      t('sprintCardMoved', {
        title: task.title,
        column: columnName(plan.column),
        index: plan.index + 1,
        total: plan.total,
      }),
    );
    const input = {
      workspace_id: workspace.id,
      task_id: task.id,
      column_id: plan.column.id,
      ...(plan.afterTaskId === undefined ? {} : { after_task_id: plan.afterTaskId }),
    };
    const workspaceId = workspace.id;
    void moves.send(
      () => callOperation(taskColumnMove, input, { slug }),
      async (result) => {
        // 送っている間に別のワークスペースへ移っていたら、古い応答で状態を触らない
        if (workspaceId !== page.params.id || result.ok) return;
        // 401 は、枠の読み直しがログインの画面へ移す
        if (result.status === 401) {
          await invalidateAll();
          return;
        }
        showToast(moveFailureMessage(result), 'alert');
        if (result.status === 409 && result.error?.code === 'workspace_closed') await invalidate('app:workspace');
        await reloadBoard();
      },
    );
  }

  async function complete(task: SprintBoardTask): Promise<void> {
    if (workspace === null || completingId !== null) return;
    completingId = task.id;
    const workspaceId = workspace.id;
    try {
      const result = await callOperation(taskComplete, { workspace_id: workspaceId, task_id: task.id }, { slug });
      // 送っている間に別のワークスペースへ移っていたら、古い応答で状態を触らない
      if (workspaceId !== page.params.id) return;
      if (result.ok || (result.status === 409 && result.error?.code === 'conflict')) {
        // 別の画面で先に完了にされていたときも、読み直して完了の列に置く
        const message = result.ok
          ? completedMessage(result.data.left_sprint, t)
          : t('taskAlreadyDone', { task: t('task'), done: t('done') });
        // トーストが読み上げる
        showToast(message, 'check');
        await invalidate('app:sprint-board');
        // 完了の列のカードは選べない。同じカードの題のリンクへフォーカスを移す
        await tick();
        document.querySelector<HTMLElement>(`a[data-task-id="${CSS.escape(task.id)}"]`)?.focus();
      } else if (result.status === 401) {
        await invalidateAll();
      } else if (result.status === 404) {
        showToast(t('taskGone', { task: t('task') }), 'alert');
        await invalidate('app:sprint-board');
      } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
        showToast(t('workspaceClosedReadOnly', { workspace: t('workspace') }), 'alert');
        await invalidate('app:workspace');
      } else {
        showToast(t('taskCompleteFailed', { done: t('done') }), 'alert');
      }
    } finally {
      completingId = null;
    }
  }

  const emptyText = $derived(
    isClosed
      ? t('sprintBoardEmptyClosedText', { workspace: t('workspace'), sprint: t('sprint') })
      : isLeader
        ? t('sprintBoardEmptyLeaderText', {
            plan: t('plan'),
            sprint: t('sprint'),
            backlog: t('backlog'),
            task: t('task'),
            column: t('column'),
          })
        : t('sprintBoardEmptyMemberText', {
            sprint: t('sprint'),
            leader: t('leader'),
            task: t('task'),
            backlog: t('backlog'),
            done: t('done'),
          }),
  );
</script>

<svelte:head>
  {#if workspace && board !== null}
    <title>
      {t('pageTitle', {
        page: t('sprintBoardPageName', {
          name: sprint === null ? t('sprint') : sprintLabel(sprint, t),
          workspace: workspace.name,
        }),
        app: t('appName'),
      })}
    </title>
  {/if}
</svelte:head>

{#if workspace && board === null}
  <LoadFailed inShell />
{:else if workspace && board !== null}
  <!-- 読み上げの領域。常に置き、文字だけを替える -->
  <div class="visually-hidden" role="status">
    {status}{completingId !== null ? t('sprintCardCompleting', { done: t('done') }) : ''}
  </div>

  {#if sprint === null || progress === null}
    <PageHead title={t('sprint')} eyebrow={workspace.name} focusable />
    <EmptyState icon="columns" title={t('sprintBoardEmptyTitle', { sprint: t('sprint') })} text={emptyText}>
      {#snippet actions()}
        {#if isLeader}
          <a class="btn is-sm" href={planHref}>{t('sprintBoardOpenPlan', { plan: t('plan') })}</a>
        {:else}
          <a class="btn is-sm" href={backlogHref}>{t('sprintBoardOpenBacklog', { backlog: t('backlog') })}</a>
        {/if}
      {/snippet}
    </EmptyState>
  {:else}
    <PageHead
      title={sprintLabel(sprint, t)}
      eyebrow={t('sprintBoardEyebrow', {
        period: sprintPeriod(sprint, t),
        length: progress.length,
        day: progress.day,
      })}
      {tallies}
      focusable
    />
    {#if sprint.goal !== null}
      <article class="notice">
        <span class="notice-label">{t('sprintGoal')}</span>
        <p class="notice-title is-goal">{sprint.goal}</p>
      </article>
    {/if}
    <div
      class="board-wrap"
      role="region"
      aria-label={t('sprintBoardRegion', { sprint: t('sprint'), column: t('column') })}
    >
      <div class="board" style:--board-cols={columns.length}>
        {#each columns as column (column.id)}
          <section class="board-col" class:is-done={column.is_done} aria-label={columnName(column)}>
            <div class="board-col-head">
              {#if column.is_done}<Icon name="check" />{/if}
              <span class="board-col-name">{columnName(column)}</span>
              <span class="board-col-n">{column.tasks.length}</span>
              <span class="board-col-pts">{t('sprintBoardColumnPoints', { points: pointsOf(column.tasks) })}</span>
            </div>
            {#each column.tasks as task (task.id)}
              <SprintCard
                {task}
                href="{sprintHref}?task={encodeURIComponent(task.id)}"
                edges={canWrite ? edgesOf(columns, task.id) : null}
                canComplete={canWrite}
                pending={completingId !== null}
                onmove={moveCard}
                oncomplete={(target) => void complete(target)}
              />
            {:else}
              <p class="board-empty">{t('sprintBoardColumnEmpty')}</p>
            {/each}
          </section>
        {/each}
      </div>
    </div>
    {#if canWrite}
      <p class="action-note">{t('sprintBoardKeyHint', { column: t('column') })}</p>
    {/if}
  {/if}
{/if}
