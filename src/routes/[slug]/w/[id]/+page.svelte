<script lang="ts">
  import { tick } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import EmptyState from '../../../../lib/components/EmptyState.svelte';
  import Icon from '../../../../lib/components/Icon.svelte';
  import LoadFailed from '../../../../lib/components/LoadFailed.svelte';
  import PageHead from '../../../../lib/components/PageHead.svelte';
  import StoryDialog from '../../../../lib/components/StoryDialog.svelte';
  import TaskCreateDialog from '../../../../lib/components/TaskCreateDialog.svelte';
  import TaskEntry from '../../../../lib/components/TaskEntry.svelte';
  import TaskMoveDialog from '../../../../lib/components/TaskMoveDialog.svelte';
  import TreeStory from '../../../../lib/components/TreeStory.svelte';
  import { callOperation, type ApiResult } from '../../../../lib/api.ts';
  import { showToast } from '../../../../lib/toast.svelte.ts';
  import { t } from '../../../../lib/vocabulary.svelte.ts';
  import { storyMove } from '../../../../shared/operations/story/index.ts';
  import type { BacklogStory, BacklogTask } from '../../../../shared/operations/task/backlog-tree.ts';
  import { taskComplete, taskMove } from '../../../../shared/operations/task/index.ts';
  import { moveConflictReasonOf } from '../../../../shared/operations/task/task-move.ts';
  import type { PageProps } from './$types';

  // ワークスペースの画面（backlog.html の木と起票）。最上段は見本どおり「親のないストーリー → 親のないタスク」の2段で、
  // それぞれ position の順。ストーリーの下には未完了のタスクを並べ、完了したタスクは件数の1行にする。
  // 絞り込み、折りたたみを開ける操作、ドラッグでの並べ替え、エピックの段は、それぞれの機能の Issue で足す。
  // 並べ替えは、行の「上へ」「下へ」と Alt と ↑ ↓ で、同じ親（親なしのタスク、親のないストーリーはそれぞれの段）の中で1つ動かす。
  // タスクの行の「親を移す」は、ダイアログで選んだ親の末尾へ移す。どちらも先に画面を動かしてから送り、送る順は守る（moveQueue）。
  // 失敗したら理由を知らせて読み直す。動かした並びは読み直すまで画面に持ち、読み直したら捨てる（読み直した値が送った後の並び）。
  // 送り終える前に木が読み直されたら、送り終えた後にもう一度読み直す（捨てた移動があれば知らせる）。
  // 見出しは見本どおり画面の名前（掲示板／バックログ）で、小見出しがワークスペースの名前。見出しの右に、ストーリーを作るボタンと起票のボタン。
  // 閉じていれば、作る操作と完了の操作は出さない（ストーリーのダイアログは読み取り専用で開く。閉じていることはワークスペースの枠の帯が伝える）。
  // 完了にした行は、読み直すまで完了の印を付けてその場に残し、その行のポイントを親の「完了」に即時に足す。折りたたみの件数は読み直した値なので、その行は読み直すまで入らない。
  // 起票したタスクは、読み直さずに親の配下（親なしなら一覧の末尾）に足し、親の「全体」のポイントにも足す。親の行が畳まれていれば開く。
  // ストーリーを作った、直したときは、木を読み直す。
  // 完了の操作を送っている最中の行（pendingIds）は、読み直しでは捨てず、応答が来たら外す
  let { data }: PageProps = $props();

  const workspace = $derived(data.workspace);
  const tree = $derived(data.tree);
  const canWrite = $derived(workspace !== null && workspace.closedAt === null);
  // 期日の印を決める、ワークスペースの今日の日付と週の始まり（API の値）
  const clock = $derived({ today: tree?.today ?? '', weekStart: tree?.week_start ?? 1 });

  // 親なしのタスクの並びのキー。ストーリーの ID とぶつからない
  const ROOT = '';

  // 読み直したら（枠の読み直し、ワークスペースの切り替え）、足した行と完了の印と、画面で動かした並びを捨てる
  let added = $state<{ task: BacklogTask; storyId: string | null }[]>([]);
  let completedIds = $state<string[]>([]);
  let pendingIds = $state<string[]>([]);
  // 画面で親を移したタスク（値は移す先の親。null は親なし）と、並べ替えた親ごとの id の並び（キーは親の ID か ROOT）、ストーリーの並び
  let movedParents = $state<Record<string, string | null>>({});
  let taskOrders = $state<Record<string, string[]>>({});
  let storyOrder = $state<string[] | null>(null);
  // 動かす操作は、押した順に1つずつ送る。読み直したら世代を進め、まだ送っていない古い操作は捨てる
  let moveQueue: Promise<void> = Promise.resolve();
  let moveGeneration = 0;
  $effect.pre(() => {
    void tree;
    added = [];
    completedIds = [];
    movedParents = {};
    taskOrders = {};
    storyOrder = null;
    moveGeneration++;
  });

  // order の順に並べる。order に無い行（後から足した行）は、元の順のまま後ろに置く
  function sortedBy<T extends { id: string }>(rows: readonly T[], order: readonly string[]): T[] {
    const rank = new Map(order.map((id, index) => [id, index]));
    const rankOf = (row: T, index: number) => rank.get(row.id) ?? order.length + index;
    return rows
      .map((row, index) => ({ row, rank: rankOf(row, index) }))
      .sort((a, b) => a.rank - b.rank)
      .map((entry) => entry.row);
  }

  // 親ごとの未完了の行（キーは親の ID か ROOT）。読み直した一覧と足した行が重なっても（起票の直後に読み直したときなど）、
  // 同じ id の行は1つにする。画面で親を移した行は移す先に置き、並べ替えた親はその並びに従う
  function listTasks(): Record<string, BacklogTask[]> {
    const lists: Record<string, BacklogTask[]> = {};
    const seen: Record<string, true> = {};
    const place = (task: BacklogTask, parentId: string | null) => {
      if (seen[task.id]) return;
      seen[task.id] = true;
      const moved = Object.hasOwn(movedParents, task.id) ? (movedParents[task.id] ?? null) : parentId;
      (lists[moved ?? ROOT] ??= []).push(task);
    };
    for (const story of tree?.stories ?? []) for (const task of story.tasks) place(task, story.id);
    for (const task of tree?.tasks ?? []) place(task, null);
    for (const entry of added) place(entry.task, entry.storyId);
    for (const [key, list] of Object.entries(lists)) {
      const order = taskOrders[key];
      if (order !== undefined) lists[key] = sortedBy(list, order);
    }
    return lists;
  }
  const taskLists = $derived(listTasks());

  // タスクの行の、親と並びの中の位置。上へ、下へのボタンの端の判定と、親を移すダイアログの今の親に使う
  function placeTasks(lists: Record<string, BacklogTask[]>) {
    const places: Record<string, { parentId: string | null; index: number; count: number }> = {};
    for (const [key, list] of Object.entries(lists)) {
      list.forEach((task, index) => {
        places[task.id] = { parentId: key === ROOT ? null : key, index, count: list.length };
      });
    }
    return places;
  }
  const taskPlaces = $derived(placeTasks(taskLists));

  const storyList = $derived(storyOrder === null ? (tree?.stories ?? []) : sortedBy(tree?.stories ?? [], storyOrder));
  const rootRows = $derived(taskLists[ROOT] ?? []);
  const openStories = $derived(storyList.filter((story) => story.completed_at === null));

  function storyRows(story: BacklogStory): BacklogTask[] {
    return taskLists[story.id] ?? [];
  }

  // 親の「全体」のポイント。足した行と、画面で移してきた行の分を足し、画面で外へ移した行の分を引く
  function pointsAllOf(story: BacklogStory): number {
    const rows = storyRows(story);
    const known = new Set(story.tasks.map((task) => task.id));
    const here = new Set(rows.map((task) => task.id));
    const gained = rows.filter((task) => !known.has(task.id));
    const lost = story.tasks.filter((task) => !here.has(task.id));
    const sum = (tasks: readonly BacklogTask[]) => tasks.reduce((total, task) => total + (task.points ?? 0), 0);
    return story.points_all + sum(gained) - sum(lost);
  }

  // 完了にした行のポイントを、親の「完了」に足す。完了にした行は、読み直した一覧では未完了だった行か、足した行なので、
  // 読み直した「完了」の合計には入っていない
  function pointsDoneOf(story: BacklogStory): number {
    const done = storyRows(story).filter((task) => completedIds.includes(task.id));
    return story.points_done + done.reduce((sum, task) => sum + (task.points ?? 0), 0);
  }

  const completingStatus = $derived(pendingIds.length > 0 ? t('taskCompleting', { done: t('done') }) : '');
  let taskDialog = $state<ReturnType<typeof TaskCreateDialog>>();
  let storyDialog = $state<ReturnType<typeof StoryDialog>>();
  // 完了にした行の完了の印へフォーカスを移すために持つ。描き直しには使わない
  const entries: Record<string, ReturnType<typeof TaskEntry> | undefined> = {};
  // ストーリーの行。起票した親の行を開くために持つ
  const treeRows: Record<string, ReturnType<typeof TreeStory> | undefined> = {};

  async function complete(task: BacklogTask): Promise<void> {
    if (workspace === null || pendingIds.includes(task.id)) return;
    pendingIds = [...pendingIds, task.id];
    const workspaceId = workspace.id;
    try {
      const result = await callOperation(
        taskComplete,
        { workspace_id: workspaceId, task_id: task.id },
        { slug: page.params.slug ?? '' },
      );
      // 送っている間に別のワークスペースへ移っていたら、古い応答で状態を触らない
      if (workspaceId !== page.params.id) return;
      if (result.ok || (result.status === 409 && result.error?.code === 'conflict')) {
        completedIds = [...completedIds, task.id];
        // 別の画面で先に完了にされていたときは、同じ完了の印で示し、知らせる
        showToast(
          result.ok
            ? t('taskCompleted', { task: t('task'), done: t('done') })
            : t('taskAlreadyDone', { task: t('task'), done: t('done') }),
          'check',
        );
        // 押したボタンは完了の印に替わって消えるので、フォーカスを印へ移す
        await tick();
        entries[task.id]?.focusMark();
      } else if (result.status === 401) {
        await invalidateAll();
      } else if (result.status === 404) {
        // タスクが消えている。木を読み直して、行を外す
        showToast(t('taskGone', { task: t('task') }), 'alert');
        await invalidateAll();
      } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
        // 閉じた。読み直して、閉じた表示（作る操作と完了の操作を出さない）に切り替える
        showToast(t('workspaceClosedReadOnly', { workspace: t('workspace') }), 'alert');
        await invalidateAll();
      } else {
        showToast(t('taskCompleteFailed', { done: t('done') }), 'alert');
      }
    } finally {
      pendingIds = pendingIds.filter((id) => id !== task.id);
    }
  }

  function created(task: BacklogTask, storyId: string | null): void {
    added = [...added, { task, storyId }];
    // 畳まれている親の行は開いて、足した行が見えるようにする
    if (storyId !== null) treeRows[storyId]?.expand();
  }

  // 直す対象のストーリーが消えていた。木を読み直し、フォーカスを見出しへ移す（ダイアログが閉じて、戻る先が無いため）
  async function storyGone(): Promise<void> {
    await invalidateAll();
    await tick();
    document.querySelector<HTMLElement>('h1.page-title')?.focus();
  }

  let moveDialog = $state<ReturnType<typeof TaskMoveDialog>>();
  // 動かした結果の読み上げ。領域は常に置き、中の文字だけを替える。同じ文が続いても読まれるよう、一度空にしてから入れる
  let moveStatus = $state('');
  async function announce(message: string): Promise<void> {
    moveStatus = '';
    await tick();
    moveStatus = message;
  }

  // 並べ替えで行の要素が動くと、その中のフォーカスが外れることがある。動かす前のフォーカスを、描き直した後に戻す
  function holdFocus(): () => Promise<void> {
    const active = document.activeElement;
    return async () => {
      await tick();
      if (active instanceof HTMLElement && active.isConnected && document.activeElement !== active) active.focus();
    };
  }

  // ids の中で id を1つ動かした並びと、送る直前の行。下へは次の行の直後、上へは2つ上の行の直後（先頭になるなら null）
  function shifted(ids: readonly string[], id: string, delta: -1 | 1) {
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= ids.length) return null;
    const next = ids.filter((other) => other !== id);
    next.splice(to, 0, id);
    return { ids: next, index: to, after: to === 0 ? null : next[to - 1]! };
  }

  // 画面で動かした並びを捨てる。まだ送っていない操作も、世代を進めて捨てる
  function discardMoves(): void {
    movedParents = {};
    taskOrders = {};
    storyOrder = null;
    moveGeneration++;
  }

  // 木を読み直す。読み直しが失敗しても、送れなかった並びを出し続けない
  async function reloadTree(): Promise<void> {
    try {
      await invalidateAll();
    } finally {
      discardMoves();
    }
  }

  // 失敗した移動の理由。409 の conflict は、サーバーが details.reason に載せた理由で分ける
  function moveFailureMessage(result: { status: number; error: { code: string; details?: unknown } | null }): string {
    if (result.status === 404) return t('moveGone');
    if (result.status !== 409) return t('moveFailed');
    if (result.error?.code === 'workspace_closed') return t('workspaceClosedReadOnly', { workspace: t('workspace') });
    switch (moveConflictReasonOf(result.error?.details)) {
      case 'parent_completed':
        return t('moveParentDone', { done: t('done'), story: t('story') });
      case 'task_completed':
        return t('moveTaskDone', { task: t('task'), done: t('done') });
      case 'changed':
        return t('moveConflict');
      default:
        return t('moveFailed');
    }
  }

  // フォーカスのある行（data-row-id）と、その行の中で何番目の操作か。読み直した後に同じ操作へ戻す
  function focusedControl(): { rowId: string; index: number } | null {
    const active = document.activeElement;
    const row = active instanceof HTMLElement ? active.closest<HTMLElement>('[data-row-id]') : null;
    if (row === null || !(active instanceof HTMLElement)) return null;
    const index = [...row.querySelectorAll<HTMLElement>('a, button')].indexOf(active);
    return index === -1 ? null : { rowId: row.dataset.rowId ?? '', index };
  }

  async function restoreFocus(saved: { rowId: string; index: number } | null, lost: boolean): Promise<void> {
    if (saved === null && !lost) return;
    await tick();
    const row =
      saved === null
        ? null
        : [...document.querySelectorAll<HTMLElement>('[data-row-id]')].find((el) => el.dataset.rowId === saved.rowId);
    const control = saved === null ? undefined : row?.querySelectorAll<HTMLElement>('a, button')[saved.index];
    (control ?? document.querySelector<HTMLElement>('h1.page-title'))?.focus();
  }

  // 押したが、まだ結果を受け取っていない移動の数（待っているものと送っているもの）。
  // その間に木が読み直されたら（reloadedWhileMoving）、送っている移動が読み直しの後に届いて古い並びが残りうるので、
  // 送り終えた後にもう一度読み直す。待っていて捨てた移動（droppedMoves）があれば、そのことを知らせる
  let pendingMoves = 0;
  let reloadedWhileMoving = false;
  let droppedMoves = 0;
  $effect.pre(() => {
    void tree;
    if (pendingMoves > 0) reloadedWhileMoving = true;
  });

  async function settleMoves(): Promise<void> {
    if (pendingMoves > 0 || !reloadedWhileMoving) return;
    reloadedWhileMoving = false;
    const dropped = droppedMoves;
    droppedMoves = 0;
    await reloadTree();
    if (dropped > 0) showToast(t('moveReloaded'), 'alert');
  }

  // 動かす操作を、押した順に送る。失敗したら理由を知らせて読み直し、フォーカスを同じ操作（無ければ見出し）へ戻す
  function send(call: () => Promise<ApiResult<unknown>>): void {
    const mine = moveGeneration;
    const workspaceId = workspace?.id;
    pendingMoves++;
    moveQueue = moveQueue
      .then(async () => {
        // 待つ間に木が読み直された移動は送らずに捨てる（result は undefined のまま）。捨てた移動も、最後の1件なら
        // 下の settleMoves() で読み直しと知らせを行う
        let result: ApiResult<unknown> | undefined;
        try {
          if (mine !== moveGeneration) droppedMoves++;
          else result = await call();
        } finally {
          pendingMoves--;
        }
        // 送っている間に別のワークスペースへ移っていたら、古い応答で状態を触らない
        if (result !== undefined && !result.ok && workspaceId === page.params.id) {
          // 401 は、枠の読み直しがログインの画面へ移す
          if (result.status !== 401) showToast(moveFailureMessage(result), 'alert');
          const saved = focusedControl();
          const lost = document.activeElement === null || document.activeElement === document.body;
          await reloadTree();
          await restoreFocus(saved, lost);
        }
        await settleMoves();
      })
      .catch(() => {});
  }

  function reorderTask(task: BacklogTask, delta: -1 | 1): void {
    if (workspace === null) return;
    const parentId = taskPlaces[task.id]?.parentId ?? null;
    const key = parentId ?? ROOT;
    const next = shifted(
      (taskLists[key] ?? []).map((row) => row.id),
      task.id,
      delta,
    );
    // 端で Alt と ↑ ↓ を押したときは、動かせないことを読み上げる
    if (next === null) {
      void announce(delta < 0 ? t('moveAtTop') : t('moveAtBottom'));
      return;
    }
    const restore = holdFocus();
    taskOrders = { ...taskOrders, [key]: next.ids };
    void restore();
    void announce(t('moveAnnounced', { title: task.title, index: next.index + 1 }));
    const input = { workspace_id: workspace.id, task_id: task.id, story_id: parentId, after_task_id: next.after };
    send(() => callOperation(taskMove, input, { slug: page.params.slug ?? '' }));
  }

  function reorderStory(story: BacklogStory, delta: -1 | 1): void {
    if (workspace === null) return;
    const next = shifted(
      storyList.map((row) => row.id),
      story.id,
      delta,
    );
    if (next === null) {
      void announce(delta < 0 ? t('moveAtTop') : t('moveAtBottom'));
      return;
    }
    const restore = holdFocus();
    storyOrder = next.ids;
    void restore();
    void announce(t('moveAnnounced', { title: story.title, index: next.index + 1 }));
    const input = { workspace_id: workspace.id, story_id: story.id, epic_id: null, after_story_id: next.after };
    send(() => callOperation(storyMove, input, { slug: page.params.slug ?? '' }));
  }

  function openMoveDialog(task: BacklogTask, trigger: HTMLElement): void {
    moveDialog?.show(trigger, task, taskPlaces[task.id]?.parentId ?? null);
  }

  // 親を移す（ダイアログが閉じた後に呼ばれる）。移す先の末尾に置き（API には直前の行を送らない）、畳まれていれば開く。
  // 行は移す先の下に作り直されるので、新しい行の「親を移す」へフォーカスを移す
  function moveParent(task: BacklogTask, storyId: string | null): void {
    if (workspace === null) return;
    const key = storyId ?? ROOT;
    const ids = (taskLists[key] ?? []).map((row) => row.id).filter((id) => id !== task.id);
    movedParents = { ...movedParents, [task.id]: storyId };
    taskOrders = { ...taskOrders, [key]: [...ids, task.id] };
    if (storyId !== null) treeRows[storyId]?.expand();
    const parent = storyId === null ? undefined : storyList.find((story) => story.id === storyId);
    void tick().then(() => entries[task.id]?.focusMoveParent());
    void announce(
      parent === undefined
        ? t('moveAnnouncedRoot', { title: task.title })
        : t('moveAnnouncedUnder', { title: task.title, story: t('story'), parent: parent.title }),
    );
    const input = { workspace_id: workspace.id, task_id: task.id, story_id: storyId };
    send(() => callOperation(taskMove, input, { slug: page.params.slug ?? '' }));
  }
</script>

<svelte:head>
  {#if workspace}
    <title>
      {t('pageTitle', {
        page: t('backlogPageName', { backlog: t('backlog'), name: workspace.name }),
        app: t('appName'),
      })}
    </title>
  {/if}
</svelte:head>

{#snippet taskRow(task: BacklogTask)}
  {@const place = taskPlaces[task.id]}
  <!-- 親なしのタスクは、移す先のストーリーがあるときだけ「親を移す」を出す（ストーリーの下のタスクは、親なしへ移せる） -->
  <TaskEntry
    bind:this={entries[task.id]}
    {task}
    {clock}
    done={completedIds.includes(task.id)}
    pending={pendingIds.includes(task.id)}
    canComplete={canWrite}
    onComplete={complete}
    canMoveUp={place !== undefined && place.index > 0}
    canMoveDown={place !== undefined && place.index < place.count - 1}
    onMove={canWrite ? reorderTask : undefined}
    onMoveParent={canWrite && (place?.parentId != null || openStories.length > 0) ? openMoveDialog : undefined}
  />
{/snippet}

{#if workspace && tree === null}
  <LoadFailed inShell />
{:else if workspace && tree}
  <PageHead title={t('backlog')} eyebrow={workspace.name} focusable>
    {#snippet actions()}
      {#if canWrite}
        <button class="btn" type="button" onclick={(event) => storyDialog?.show(event.currentTarget)}>
          <Icon name="plus" />{t('storyCreate', { story: t('story') })}
        </button>
        <button class="btn is-primary" type="button" onclick={(event) => taskDialog?.show(event.currentTarget)}>
          <Icon name="plus" />{t('create')}
        </button>
      {/if}
    {/snippet}
  </PageHead>

  <!-- 完了の操作を送っている最中の読み上げと、動かした結果の読み上げ。領域は常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{completingStatus}</span>
  <span class="visually-hidden" role="status">{moveStatus}</span>

  {#if tree.stories.length === 0 && rootRows.length === 0 && tree.completed_count === 0}
    <EmptyState
      icon="board"
      title={t('backlogEmptyTitle', { task: t('task') })}
      text={canWrite
        ? t('backlogEmptyText', { task: t('task'), create: t('create') })
        : t('backlogEmptyClosedText', { task: t('task'), workspace: t('workspace') })}
    />
  {:else}
    <section class="section" aria-label={t('backlogTasksLabel', { backlog: t('backlog'), task: t('task') })}>
      {#if canWrite}
        <p class="action-note">{t('backlogOrderNote')}</p>
      {/if}
      <div class="tree">
        {#each storyList as story, index (story.id)}
          <TreeStory
            bind:this={treeRows[story.id]}
            {story}
            tasks={storyRows(story)}
            pointsDone={pointsDoneOf(story)}
            pointsAll={pointsAllOf(story)}
            {clock}
            {canWrite}
            onEdit={(target, trigger) => storyDialog?.show(trigger, target.id)}
            onAddTask={(target, trigger) => taskDialog?.show(trigger, target.id)}
            row={taskRow}
            canMoveUp={index > 0}
            canMoveDown={index < storyList.length - 1}
            onMove={canWrite ? reorderStory : undefined}
          />
        {/each}
        {#if rootRows.length > 0 || tree.completed_count > 0}
          <div>
            {#if rootRows.length === 0 && tree.stories.length === 0}
              <EmptyState
                icon="board"
                title={t('backlogNoOpenTitle', { task: t('task') })}
                text={canWrite
                  ? t('backlogNoOpenText', { task: t('task'), create: t('create') })
                  : t('backlogEmptyClosedText', { task: t('task'), workspace: t('workspace') })}
              />
            {/if}
            {#each rootRows as task (task.id)}
              {@render taskRow(task)}
            {/each}
            {#if tree.completed_count > 0}
              <p class="tree-folded is-root">
                {t('backlogFolded', { done: t('done'), count: tree.completed_count })}
              </p>
            {/if}
          </div>
        {/if}
      </div>
    </section>
  {/if}

  <!-- ストーリーのダイアログは、閉じたワークスペースでも読み取り専用で開く -->
  <StoryDialog
    bind:this={storyDialog}
    slug={page.params.slug ?? ''}
    workspaceId={workspace.id}
    {canWrite}
    onsaved={() => void invalidateAll()}
    ongone={() => void storyGone()}
  />
  {#if canWrite}
    <TaskCreateDialog
      bind:this={taskDialog}
      slug={page.params.slug ?? ''}
      workspaceId={workspace.id}
      stories={openStories}
      oncreated={created}
    />
    <TaskMoveDialog bind:this={moveDialog} stories={openStories} onmove={moveParent} />
  {/if}
{/if}
