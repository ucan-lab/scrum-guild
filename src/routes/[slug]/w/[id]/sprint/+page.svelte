<script lang="ts">
  import { tick } from 'svelte';
  import { invalidate, invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { callOperation, type ApiResult } from '../../../../../lib/api.ts';
  import EmptyState from '../../../../../lib/components/EmptyState.svelte';
  import Icon from '../../../../../lib/components/Icon.svelte';
  import LoadFailed from '../../../../../lib/components/LoadFailed.svelte';
  import Markdown from '../../../../../lib/components/Markdown.svelte';
  import PageHead from '../../../../../lib/components/PageHead.svelte';
  import SprintCard from '../../../../../lib/components/SprintCard.svelte';
  import SprintDialog from '../../../../../lib/components/SprintDialog.svelte';
  import SprintExtendDialog from '../../../../../lib/components/SprintExtendDialog.svelte';
  import SprintCloseDialog from '../../../../../lib/components/SprintCloseDialog.svelte';
  import SprintOverdueNotice from '../../../../../lib/components/SprintOverdueNotice.svelte';
  import { focusPageHeading } from '../../../../../lib/focus-heading.ts';
  import { MoveQueue } from '../../../../../lib/move-queue.ts';
  import { edgesOf, planCardMove, type MoveDirection, type MoveEdge } from '../../../../../lib/sprint-board.ts';
  import { SprintDnd } from '../../../../../lib/sprint-dnd.svelte.ts';
  import type { MovedPlan, ReopenPlan, SprintDrop } from '../../../../../lib/sprint-drop.ts';
  import { completedMessage, sprintLabel, sprintPeriod } from '../../../../../lib/sprint-label.ts';
  import { showToast } from '../../../../../lib/toast.svelte.ts';
  import { t } from '../../../../../lib/vocabulary.svelte.ts';
  import {
    columnMoveConflictReasonOf,
    taskColumnMove,
    type SprintBoardColumn,
    type SprintBoardTask,
  } from '../../../../../shared/operations/sprint/index.ts';
  import { taskComplete, taskReopen, taskReopenConflictReasonOf } from '../../../../../shared/operations/task/index.ts';
  import { sprintProgress } from '../../../../../shared/sprint.ts';
  import type { PageProps } from './$types';

  // スプリントの画面（design/sprint.html）。進行中のスプリントの列（`.board-col`）とカード（`.card`）を並べる。
  // 見出しは進行中のスプリントの名前（無ければ期間）、小見出しは期間と何日目か。ゴールを書いて始めていれば貼り紙（`.notice`）で出す。
  // カードは題（`?task=<ID>` で詳細の引き出しを開く）、親のストーリー、ポイント、担当と、完了の印か完了の操作。
  // 完了の操作は task-complete を呼ぶだけで、完了の列への移動は task-complete が行う（完了の列へ task-column-move で移すことはしない）。
  // 動かせるカード（完了していない、終了していないワークスペース）は、選んで Alt と ← → で隣の列、Alt と ↑ ↓ で列の中を動かし、
  // カードの下のボタンでも同じことができる。動かしたら先に画面の並びを替えて位置を読み上げ、押した順に1つずつ送る（MoveQueue）。
  // 最後の完了でない列の「次の列へ」と Alt と → は、完了の操作と同じく task-complete を呼ぶ。
  // 完了の列のカードは、戻せる（完了したストーリーの下でない）ときに完了の印の横に「戻す」を出し、task-reopen を呼ぶ。
  // 戻したら読み直して、戻した列のカードへフォーカスを移す。完了の列には、ワークスペースの完成の定義（空なら出さない）を畳んで置く。
  // 断られたら理由をトーストで知らせて読み直す。
  // カードのドラッグ（SprintDnd。判定は sprint-drop.ts）は、カード全体をつかみ、カードの間の線か列の囲みに落として動かす。
  // 列の中と別の列へは、ボタンと同じ流れ（先に画面の並びを替え、読み上げ、MoveQueue に積んで task-column-move）。
  // 完了の列へ落としたら、完了の操作と同じく task-complete を積む（画面の並びは替えない）。
  // 完了の列から落としたら、task-reopen で戻してから、落とした列と位置へ task-column-move を続ける（同じ待ち行列で順に送る）。
  // 画面を読み直したら、つかんでいるドラッグは取りやめ、離しても送らず、トーストで知らせる。落としたカードは光らせ、フォーカスは動かさない。
  // 進行中のスプリントが無いときは、見本の空の状態をロールで文を分けて出す。
  // 見出しの右の「終える」は、リーダー（管理者を含む）にだけ、終了していないワークスペースでだけ出し、終了のダイアログ（SprintCloseDialog）を開く。
  // 最終日がワークスペースの今日より前なら、見出しの下に終えるのを促す警告（SprintOverdueNotice）を出す。
  // 終えたら読み直して進行中の無い表示に戻り、見出しへフォーカスを移す
  let { data }: PageProps = $props();

  const workspace = $derived(data.workspace);
  const board = $derived(data.board);
  const slug = $derived(page.params.slug ?? '');
  const isAdmin = $derived(data.organization?.me.is_admin === true);
  const isLeader = $derived(workspace !== null && (workspace.role === 'leader' || isAdmin));
  const isClosed = $derived(workspace !== null && workspace.closedAt !== null);
  const canWrite = $derived(workspace !== null && !isClosed);
  const canLead = $derived(isLeader && !isClosed);
  const sprint = $derived(board?.sprint ?? null);
  // 日付は YYYY-MM-DD なので、文字列の比較が日付の前後と一致する。終了したワークスペースでは、誰も終えられないので促さない
  const overdue = $derived(!isClosed && sprint !== null && board !== null && board.today > sprint.end_on);
  let editDialog = $state<ReturnType<typeof SprintDialog>>();
  let extendDialog = $state<ReturnType<typeof SprintExtendDialog>>();
  let closeDialog = $state<ReturnType<typeof SprintCloseDialog>>();
  const sprintHref = $derived(
    resolve('/[slug]/w/[id]/sprint', { slug: page.params.slug ?? '', id: page.params.id ?? '' }),
  );
  const planHref = $derived(resolve('/[slug]/w/[id]/plan', { slug: page.params.slug ?? '', id: page.params.id ?? '' }));
  const backlogHref = $derived(resolve('/[slug]/w/[id]', { slug: page.params.slug ?? '', id: page.params.id ?? '' }));

  // 画面で動かした後の列とカード。読み直したら捨てる
  let local = $state<SprintBoardColumn[] | null>(null);
  const columns = $derived(local ?? board?.columns ?? []);
  // 動かし方の案内。動かせるカード（書き込めるときだけ）の説明に結ぶので、案内も書き込めるときだけ出す
  const KEY_HINT_ID = 'sprint-board-key-hint';
  const moves = new MoveQueue<ApiResult<unknown>>({
    reload: reloadBoard,
    dropped: () => showToast(t('moveReloaded'), 'alert'),
  });
  // ドラッグで落とした完了か戻し（と、続く列の移動）を、積んでから終えるまでのカード。この間は、そのカードをつかめない
  // （完了を送っている最中に完了の列から落とすと、誤った「完了していない」の断りが出るため）
  let sendingIds = $state<string[]>([]);
  const dnd = new SprintDnd({
    columns: () => columns,
    enabled: () => canWrite,
    busy: (id) => sendingIds.includes(id) || completingId === id || reopeningId === id,
    onDrop: dropCard,
    onStale: () => showToast(t('moveReloaded'), 'alert'),
  });
  $effect(() => dnd.monitor());
  // 読み直したら、つかんでいるドラッグは取りやめる（離しても何も送らない）。光らせているカードは、読み直した後も残す
  dnd.resetWhenChanged(() => board);
  // 完了にした、または戻したカード。読み直した後の列に出てから光らせる（応答の直後に光らせると、読み直しが遅いとき元の列で終わる）
  let flashAfterReload: string | null = null;
  $effect.pre(() => {
    void board;
    local = null;
    moves.reloaded();
    if (flashAfterReload !== null) {
      dnd.flash(flashAfterReload);
      flashAfterReload = null;
    }
  });

  // 積んだ操作（完了か戻し）を終えるまで、そのカードをつかめなくする
  function whileSending(id: string, sent: Promise<void>): void {
    sendingIds = [...sendingIds, id];
    void sent.then(() => {
      const at = sendingIds.indexOf(id);
      if (at !== -1) sendingIds = sendingIds.toSpliced(at, 1);
    });
  }

  // 動かした結果の読み上げ。領域は常に置き、中の文字だけを替える。同じ文が続いても読まれるよう、一度空にしてから入れる
  let status = $state('');
  async function announce(message: string): Promise<void> {
    status = '';
    await tick();
    status = message;
  }

  // 完了か戻しを送っている間に、もう1つの完了か戻しが来たら送らずに捨て、送っている最中であることを読み上げる。捨てたら真
  function refusedWhileBusy(): boolean {
    if (completingId === null && reopeningId === null) return false;
    void announce(
      completingId !== null
        ? t('sprintCardBusyCompleting', { done: t('done') })
        : t('sprintCardBusyReopening', { done: t('done') }),
    );
    return true;
  }

  let completingId = $state<string | null>(null);
  let reopeningId = $state<string | null>(null);
  // 完了の列の完成の定義を開いているか。本文は開くまで描かない（バックログの画面と同じ）
  let dodOpen = $state(false);

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
    return t('sprintCardNoNextColumn', { column: t('column') });
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
    // 次の列が完了の列なら、完了にする
    if (plan.kind === 'complete') {
      queueComplete(task);
      return;
    }
    // 端で押したときは、動かせないことを読み上げる
    if (plan.kind === 'edge') {
      void announce(edgeMessage(plan.edge));
      return;
    }
    applyMove(task, plan);
  }

  // 完了にする。先に押した移動を送り終えてから送るよう、同じ列に並べる。
  // 読み直しは、ここでは行わず、列が空になった後に回す（reloadOnSuccess）。読み直しが列の途中で MoveQueue の世代を進めると、
  // 続けて積んだ操作（続けて落としたカードの移動など）が送られずに捨てられるため。
  // ドラッグで落としたとき（dropped）は、完了になったカードを光らせ、フォーカスは動かさない。キーでは、読み直した後に題のリンクへ移す
  function queueComplete(task: SprintBoardTask, dropped = false): void {
    let completed = false;
    const sent = moves.send(
      async () => {
        completed = await complete(task, true);
        if (completed && dropped) flashAfterReload = task.id;
        return completed ? ({ ok: true, data: null } as const) : ({ ok: false, status: 0, error: null } as const);
      },
      async () => {},
      true,
    );
    whileSending(task.id, sent);
    if (dropped) return;
    void sent.then(async () => {
      if (!completed) return;
      await tick();
      document.querySelector<HTMLElement>(`a[data-task-id="${CSS.escape(task.id)}"]`)?.focus();
    });
  }

  // 動かした先の位置の読み上げ
  function movedMessage(task: SprintBoardTask, plan: Pick<MovedPlan, 'column' | 'index' | 'total'>): string {
    return t('sprintCardMoved', {
      title: task.title,
      column: columnName(plan.column),
      index: plan.index + 1,
      total: plan.total,
    });
  }

  // task-column-move の入力。直前のカードは、null が先頭、undefined が末尾（省く）
  function columnMoveInput(
    workspaceId: string,
    task: SprintBoardTask,
    columnId: string,
    afterTaskId: string | null | undefined,
  ) {
    return {
      workspace_id: workspaceId,
      task_id: task.id,
      column_id: columnId,
      ...(afterTaskId === undefined ? {} : { after_task_id: afterTaskId }),
    };
  }

  // 断られた task-column-move。理由を知らせて読み直す
  async function moveRefused(workspaceId: string, result: ApiResult<unknown>): Promise<void> {
    // 送っている間に別のワークスペースへ移っていたら、古い応答で状態を触らない
    if (workspaceId !== page.params.id || result.ok) return;
    // 401 は、枠の読み直しがログインの画面へ移す
    if (result.status === 401) {
      await invalidateAll();
      return;
    }
    dnd.clearFlash();
    showToast(moveFailureMessage(result), 'alert');
    if (result.status === 409 && result.error?.code === 'workspace_closed') await invalidate('app:workspace');
    await reloadBoard();
  }

  // 先に画面の並びを替えて、位置を読み上げ、task-column-move を積む（ボタンとキーとドラッグで同じ）。ドラッグで落としたときは光らせる
  function applyMove(task: SprintBoardTask, plan: MovedPlan, flash = false): void {
    if (workspace === null) return;
    const saved = savedFocus();
    local = plan.columns;
    void restoreFocus(saved);
    if (flash) dnd.flash(task.id);
    void announce(movedMessage(task, plan));
    const workspaceId = workspace.id;
    const input = columnMoveInput(workspaceId, task, plan.column.id, plan.afterTaskId);
    void moves.send(
      () => callOperation(taskColumnMove, input, { slug }),
      (result) => moveRefused(workspaceId, result),
    );
  }

  // 完了の列のカードを、完了でない列へ落とした。task-reopen で戻してから、落とした列と位置へ task-column-move を続ける。
  // 戻すのが断られたら（理由は reopen が知らせて読み直す）、列の移動は送らない。通ったら、列が空になった後で読み直す
  function applyReopenMove(task: SprintBoardTask, plan: ReopenPlan): void {
    if (workspace === null) return;
    const workspaceId = workspace.id;
    const sent = moves.send(
      async () => {
        if (!(await reopen(task, true))) return { ok: true, data: null } as const;
        const result = await callOperation(
          taskColumnMove,
          columnMoveInput(workspaceId, task, plan.column.id, plan.afterTaskId),
          {
            slug,
          },
        );
        if (result.ok && workspaceId === page.params.id) {
          void announce(movedMessage(task, plan));
          flashAfterReload = task.id;
        }
        return result;
      },
      (result) => moveRefused(workspaceId, result),
      true,
    );
    // 戻しと移動が終わるまで、そのカードをつかめない
    whileSending(task.id, sent);
  }

  // カードを落とした（つかんでいる間に画面が読み直されていれば、ここへは来ない）
  function dropCard(drop: SprintDrop): void {
    if (workspace === null || !canWrite) return;
    const task = allTasks.find((candidate) => candidate.id === drop.taskId);
    if (task === undefined) return;
    if (drop.plan.kind === 'complete') queueComplete(task, true);
    else if (drop.plan.kind === 'reopen') applyReopenMove(task, drop.plan);
    else applyMove(task, drop.plan, true);
  }

  // 完了にできたら true（別の画面で先に完了にされていたときも）。queued が真のとき（MoveQueue の中で呼ぶとき）は、通っても
  // 読み直さず、フォーカスも動かさない（列が空になった後に、呼んだ側の reloadOnSuccess が読み直す）。断られたときの扱いは同じ
  async function complete(task: SprintBoardTask, queued = false): Promise<boolean> {
    if (workspace === null || refusedWhileBusy()) return false;
    completingId = task.id;
    const workspaceId = workspace.id;
    let done = false;
    try {
      const result = await callOperation(taskComplete, { workspace_id: workspaceId, task_id: task.id }, { slug });
      // 送っている間に別のワークスペースへ移っていたら、古い応答で状態を触らない
      if (workspaceId !== page.params.id) return false;
      if (result.ok || (result.status === 409 && result.error?.code === 'conflict')) {
        done = true;
        // 別の画面で先に完了にされていたときも、読み直して完了の列に置く
        const message = result.ok
          ? completedMessage(result.data.left_sprint, t)
          : t('taskAlreadyDone', { task: t('task'), done: t('done') });
        // トーストが読み上げる
        showToast(message, 'check');
        if (!queued) {
          await invalidate('app:sprint-board');
          // 完了の列のカードは選べない。同じカードの題のリンクへフォーカスを移す
          await tick();
          document.querySelector<HTMLElement>(`a[data-task-id="${CSS.escape(task.id)}"]`)?.focus();
        }
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
    return done;
  }

  // 断られた戻しの理由。409 の conflict は、サーバーが details.reason に載せた理由で分ける
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

  // 戻す。戻せたら true。followed が真のとき（ドラッグで別の列へ落とすとき）は、通ってもトーストを出さず、読み直さず、
  // フォーカスも動かさない（続けて task-column-move を送り、列が空になった後で画面が読み直し、位置を読み上げる）。断られたときの扱いは同じ
  async function reopen(task: SprintBoardTask, followed = false): Promise<boolean> {
    if (workspace === null || refusedWhileBusy()) return false;
    reopeningId = task.id;
    const workspaceId = workspace.id;
    let reopened = false;
    try {
      const result = await callOperation(taskReopen, { workspace_id: workspaceId, task_id: task.id }, { slug });
      // 送っている間に別のワークスペースへ移っていたら、古い応答で状態を触らない
      if (workspaceId !== page.params.id) return false;
      if (result.ok) {
        reopened = true;
        if (!followed) {
          const column = columns.find((candidate) => candidate.id === result.data.column_id);
          // トーストが読み上げる。ドラッグで落としたときは、戻した列を言っても落とした列と食い違うので出さず、
          // 移した後の位置の読み上げ（sprintCardMoved）だけにする
          showToast(
            column === undefined
              ? t('taskReopened', { task: t('task'), done: t('done') })
              : t('sprintCardReopened', { title: task.title, done: t('done'), column: columnName(column) }),
            'check',
          );
          await invalidate('app:sprint-board');
          // 押した「戻す」は消えるので、戻した列に出たカードへフォーカスを移す（動かせるカードは選べる）
          await tick();
          document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(task.id)}"]`)?.focus();
        }
      } else if (result.status === 401) {
        await invalidateAll();
      } else if (result.status === 404) {
        showToast(t('taskGone', { task: t('task') }), 'alert');
        await invalidate('app:sprint-board');
      } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
        showToast(t('workspaceClosedReadOnly', { workspace: t('workspace') }), 'alert');
        await invalidate('app:workspace');
      } else if (result.status === 409) {
        showToast(reopenFailureMessage(result.error?.details), 'alert');
        await invalidate('app:sprint-board');
      } else {
        showToast(t('taskReopenFailed', { done: t('done') }), 'alert');
      }
    } finally {
      reopeningId = null;
    }
    return reopened;
  }

  function openClose(trigger: HTMLElement): void {
    if (sprint !== null) closeDialog?.show(trigger, sprint);
  }

  // 終えたら、押した「終える」が消えるので、読み直して見出しへフォーカスを移す
  async function closed(): Promise<void> {
    await invalidate('app:sprint-board');
    await tick();
    focusPageHeading();
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
    {status}{completingId !== null ? t('sprintCardCompleting', { done: t('done') }) : ''}{reopeningId !== null
      ? t('sprintCardReopening', { done: t('done') })
      : ''}
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
    >
      {#snippet actions()}
        {#if canLead}
          <button class="btn" type="button" onclick={(event) => editDialog?.show(event.currentTarget, sprint)}
            >{t('sprintEditActive', { sprintGoal: t('sprintGoal') })}</button
          >
          <button class="btn" type="button" onclick={(event) => extendDialog?.show(event.currentTarget, sprint)}
            >{t('sprintExtendAction')}</button
          >
          <button
            class="btn"
            type="button"
            aria-label={t('sprintCloseLabel', { label: sprintLabel(sprint, t) })}
            onclick={(event) => openClose(event.currentTarget)}>{t('sprintCloseAction')}</button
          >
        {/if}
      {/snippet}
    </PageHead>
    {#if sprint.extended_days > 0}<p class="action-note">{t('sprintExtended', { days: sprint.extended_days })}</p>{/if}
    {#if overdue}
      <SprintOverdueNotice {sprint} canClose={canLead} onclose={openClose} />
    {/if}
    {#if sprint.goal !== null}
      <article class="notice">
        <span class="notice-label">{t('sprintGoal')}</span>
        <p class="notice-title is-goal">{sprint.goal}</p>
      </article>
    {/if}
    <!-- 列が並ぶと狭い幅で横に溢れる。カードが無いと中に止まる先が無く、キーボードで横へ送れないので、その間だけ領域に止まる -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="board-wrap"
      role="region"
      aria-label={t('sprintBoardRegion', { sprint: t('sprint'), column: t('column') })}
      tabindex={allTasks.length === 0 ? 0 : undefined}
      {@attach canWrite ? (node) => dnd.wrap(node) : undefined}
    >
      <div class="board" style:--board-cols={columns.length}>
        {#each columns as column (column.id)}
          <section
            class="board-col"
            class:is-done={column.is_done}
            aria-label={columnName(column)}
            data-drop={canWrite ? dnd.markOfColumn(column.id) : undefined}
            {@attach canWrite ? dnd.column(column.id) : undefined}
          >
            <div class="board-col-head">
              {#if column.is_done}<Icon name="check" />{/if}
              <span class="board-col-name">{columnName(column)}</span>
              <span class="board-col-n">{column.tasks.length}</span>
              <span class="board-col-pts">{t('sprintBoardColumnPoints', { points: pointsOf(column.tasks) })}</span>
            </div>
            <!-- 完成の定義（components.css の .dod。kit.js の board）。完了の列にだけ畳んで置き、空なら出さない。本文は開くまで描かない -->
            {#if column.is_done && workspace.definitionOfDone !== null}
              <details class="dod" bind:open={dodOpen}>
                <summary>{t('dod')}</summary>
                {#if dodOpen}<Markdown source={workspace.definitionOfDone} headingStart={2} />{/if}
              </details>
            {/if}
            {#each column.tasks as task (task.id)}
              <SprintCard
                {task}
                href="{sprintHref}?task={encodeURIComponent(task.id)}"
                edges={canWrite ? edgesOf(columns, task.id) : null}
                canComplete={canWrite}
                canReopen={canWrite && task.reopenable}
                clock={{ today: board.today, weekStart: board.week_start }}
                pending={completingId !== null || reopeningId !== null}
                hintId={KEY_HINT_ID}
                dnd={canWrite ? dnd : undefined}
                onmove={moveCard}
                oncomplete={(target) => void complete(target)}
                onreopen={(target) => void reopen(target)}
              />
            {:else}
              <p class="board-empty">{t('sprintBoardColumnEmpty')}</p>
            {/each}
          </section>
        {/each}
      </div>
    </div>
    {#if canWrite}
      <p class="action-note" id={KEY_HINT_ID}>{t('sprintBoardKeyHint', { column: t('column'), done: t('done') })}</p>
    {/if}
  {/if}
  {#key workspace.id}
    <SprintExtendDialog
      bind:this={extendDialog}
      {slug}
      workspaceId={workspace.id}
      onextended={() => void invalidate('app:sprint-board')}
      ongone={() => void invalidate('app:sprint-board')}
    />
    <SprintDialog
      bind:this={editDialog}
      {slug}
      workspaceId={workspace.id}
      onsaved={() => void invalidate('app:sprint-board')}
      ongone={() => void invalidate('app:sprint-board')}
    />
    <SprintCloseDialog
      bind:this={closeDialog}
      {slug}
      workspaceId={workspace.id}
      onclosed={() => void closed()}
      ongone={() => void invalidate('app:sprint-board')}
    />
  {/key}
{/if}
