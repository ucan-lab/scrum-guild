<script lang="ts">
  import { tick } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import EmptyState from '../../../../lib/components/EmptyState.svelte';
  import EpicDialog from '../../../../lib/components/EpicDialog.svelte';
  import Icon from '../../../../lib/components/Icon.svelte';
  import LoadFailed from '../../../../lib/components/LoadFailed.svelte';
  import Markdown from '../../../../lib/components/Markdown.svelte';
  import MoveParentDialog from '../../../../lib/components/MoveParentDialog.svelte';
  import PageHead from '../../../../lib/components/PageHead.svelte';
  import StoryDialog from '../../../../lib/components/StoryDialog.svelte';
  import TeamExperience from '../../../../lib/components/TeamExperience.svelte';
  import TaskCreateDialog from '../../../../lib/components/TaskCreateDialog.svelte';
  import TaskEntry from '../../../../lib/components/TaskEntry.svelte';
  import TreeEpic from '../../../../lib/components/TreeEpic.svelte';
  import TreeStory from '../../../../lib/components/TreeStory.svelte';
  import { callOperation, type ApiResult } from '../../../../lib/api.ts';
  import { BacklogDnd } from '../../../../lib/backlog-dnd.svelte.ts';
  import { indexTree, ROOT, type DropMove, type DropRow } from '../../../../lib/backlog-drop.ts';
  import { MoveQueue } from '../../../../lib/move-queue.ts';
  import { showToast } from '../../../../lib/toast.svelte.ts';
  import { t } from '../../../../lib/vocabulary.svelte.ts';
  import { storyComplete, storyMove, storyReopen } from '../../../../shared/operations/story/index.ts';
  import { storyCompletionConflictReasonOf } from '../../../../shared/operations/story/story-complete.ts';
  import type { BacklogEpic, BacklogStory, BacklogTask } from '../../../../shared/operations/task/backlog-tree.ts';
  import { taskComplete, taskMove } from '../../../../shared/operations/task/index.ts';
  import { moveConflictReasonOf } from '../../../../shared/operations/task/task-move.ts';
  import type { PageProps } from './$types';

  // ワークスペースの画面（backlog.html の木と起票）。最上段は見本どおり「エピック → 親のないストーリー → 親のないタスク」の3段で、
  // それぞれ position の順。エピックの下にはストーリーを、ストーリーの下には未完了のタスクを並べ、完了したタスクは件数の1行にする。
  // 絞り込み、折りたたみを開ける操作、エピックの並べ替え（#308）は、それぞれの機能の Issue で足す。
  // 並べ替えは、行の「上へ」「下へ」と Alt と ↑ ↓ で、同じ親（親なしのタスク、親のないストーリー、エピックの下のストーリーはそれぞれの並び）の中で1つ動かす。
  // タスクとストーリーの行の「親を移す」は、ダイアログで選んだ親の末尾へ移す。
  // 行の先頭のつまみのドラッグ（BacklogDnd。判定は backlog-drop.ts）は、離れた位置や別の親へ、行の間の線か親の行の囲みに落として動かす。
  // ドラッグの間に木が読み直されたら、そのドラッグは取りやめる。落とした行は、少しのあいだ光らせる。
  // どれも先に画面を動かしてから送り、送る順は守る（MoveQueue）。
  // 失敗したら理由を知らせて読み直す。動かした並びは読み直すまで画面に持ち、読み直したら捨てる（読み直した値が送った後の並び）。
  // 送り終える前に木が読み直されたら、送り終えた後にもう一度読み直す（捨てた移動があれば知らせる）。
  // 見出しは見本どおり画面の名前（掲示板／バックログ）で、小見出しがワークスペースの名前。見出しの右に、エピックを作るボタン、
  // ストーリーを作るボタンと起票のボタン。見出しの集計の下に、チーム全体の経験値（読めたときだけ）。
  // 閉じていれば、作る操作と完了の操作は出さない（エピックとストーリーのダイアログは読み取り専用で開く。閉じていることはワークスペースの枠の帯が伝える）。
  // 完了にしたタスクの行は、読み直すまで完了の印を付けてその場に残し、その行のポイントを親の「完了」に即時に足す。折りたたみの件数は読み直した値なので、その行は読み直すまで入らない。
  // ストーリーの「完了にする」は、配下の未完了のタスク（画面で完了にした行は数えない）が残るあいだは押せない。完了と取り消しは、通ったら木を読み直す。
  // 起票したタスクは、読み直さずに親の配下（親なしなら一覧の末尾）に足し、親の「全体」のポイントにも足す。親の行が畳まれていれば開く。
  // エピックとストーリーを作った、直したときは、木を読み直す。
  // 完了の操作を送っている最中の行（pendingIds、storyPending）は、読み直しでは捨てず、応答が来たら外す。
  // 見出しの下に、ワークスペースの完成の定義（枠の値。空なら出さない）を畳んで1つだけ置く
  let { data }: PageProps = $props();

  const workspace = $derived(data.workspace);
  const tree = $derived(data.tree);
  const canWrite = $derived(workspace !== null && workspace.closedAt === null);
  // 完成の定義の畳みを開いたか。開くまで本文を描かない
  let dodOpen = $state(false);
  // 期日の印を決める、ワークスペースの今日の日付と週の始まり（API の値）
  const clock = $derived({ today: tree?.today ?? '', weekStart: tree?.week_start ?? 1 });

  // 読み直したら（枠の読み直し、ワークスペースの切り替え）、足した行と完了の印と、画面で動かした並びを捨てる
  let added = $state<{ task: BacklogTask; storyId: string | null }[]>([]);
  let completedIds = $state<string[]>([]);
  let pendingIds = $state<string[]>([]);
  // 完了か取り消しを送っている最中のストーリーと、送っている操作
  let storyPending = $state<Record<string, 'complete' | 'reopen'>>({});
  // 画面で親を移したタスク（値は移す先の親。null は親なし）と、並べ替えた親ごとの id の並び（キーは親の ID か ROOT）。
  // ストーリーも同じ形で持つ（親はエピック）
  let movedParents = $state<Record<string, string | null>>({});
  let taskOrders = $state<Record<string, string[]>>({});
  let movedStoryParents = $state<Record<string, string | null>>({});
  let storyOrders = $state<Record<string, string[]>>({});
  // 動かす操作は、押した順に1つずつ送る（src/lib/move-queue.ts）。読み直したら、まだ送っていない古い操作は捨てる
  const moves = new MoveQueue<ApiResult<unknown>>({
    reload: () => reloadTree(),
    dropped: () => showToast(t('moveReloaded'), 'alert'),
  });
  $effect.pre(() => {
    void tree;
    added = [];
    completedIds = [];
    movedParents = {};
    taskOrders = {};
    movedStoryParents = {};
    storyOrders = {};
    moves.reloaded();
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

  // 親ごとの行（キーは親の ID か ROOT）。画面で親を移した行は移す先に置き、並べ替えた親はその並びに従う
  function grouped<T extends { id: string }>(
    rows: readonly { row: T; parentId: string | null }[],
    moved: Record<string, string | null>,
    orders: Record<string, string[]>,
  ): Record<string, T[]> {
    const lists: Record<string, T[]> = {};
    const seen: Record<string, true> = {};
    for (const { row, parentId } of rows) {
      // 読み直した一覧と足した行が重なっても（起票の直後に読み直したときなど）、同じ id の行は1つにする
      if (seen[row.id]) continue;
      seen[row.id] = true;
      const target = Object.hasOwn(moved, row.id) ? (moved[row.id] ?? null) : parentId;
      (lists[target ?? ROOT] ??= []).push(row);
    }
    for (const [key, list] of Object.entries(lists)) {
      const order = orders[key];
      if (order !== undefined) lists[key] = sortedBy(list, order);
    }
    return lists;
  }

  // 親ごとの行の、親と並びの中の位置。上へ、下へのボタンの端の判定と、親を移すダイアログの今の親に使う
  function placesOf<T extends { id: string }>(lists: Record<string, T[]>) {
    const places: Record<string, { parentId: string | null; index: number; count: number }> = {};
    for (const [key, list] of Object.entries(lists)) {
      list.forEach((row, index) => {
        places[row.id] = { parentId: key === ROOT ? null : key, index, count: list.length };
      });
    }
    return places;
  }

  const epics = $derived(tree?.epics ?? []);
  // 読み直した木のストーリー（エピックの下のものと親のないもの）と、その親
  const loadedStories = $derived([
    ...epics.flatMap((epic) => epic.stories.map((story) => ({ row: story, parentId: epic.id as string | null }))),
    ...(tree?.stories ?? []).map((story) => ({ row: story, parentId: null })),
  ]);
  const storyLists = $derived(grouped(loadedStories, movedStoryParents, storyOrders));
  const storyPlaces = $derived(placesOf(storyLists));
  const rootStoryList = $derived(storyLists[ROOT] ?? []);
  // 木の順（エピックの下、親のないものの順）に並べたストーリー
  const allStories = $derived([...epics.flatMap((epic) => storyLists[epic.id] ?? []), ...rootStoryList]);
  // 今その下に並んでいる、ストーリーの親のエピック。親なしなら undefined
  function parentEpicOf(storyId: string): BacklogEpic | undefined {
    const epicId = storyPlaces[storyId]?.parentId;
    return epicId == null ? undefined : epics.find((epic) => epic.id === epicId);
  }
  // タスクの親に選べるストーリー（完了していないもの）。選択欄は親のエピック（親なしは null）でまとめる。
  // ストーリーの親に選べるエピック（完了も中止もしていないもの）
  const openStories = $derived(
    allStories
      .filter((story) => story.completed_at === null)
      .map((story) => {
        const epic = parentEpicOf(story.id);
        return {
          id: story.id,
          title: story.title,
          group: epic === undefined ? null : { id: epic.id, title: epic.title },
          // 起票のダイアログで、この親を選んだときに引き継ぐ区分
          category: story.category,
        };
      }),
  );
  const openEpics = $derived(epics.filter((epic) => epic.completed_at === null && epic.canceled_at === null));

  const taskLists = $derived(
    grouped(
      [
        ...loadedStories.flatMap(({ row: story }) => story.tasks.map((task) => ({ row: task, parentId: story.id }))),
        ...(tree?.tasks ?? []).map((task) => ({ row: task, parentId: null })),
        ...added.map((entry) => ({ row: entry.task, parentId: entry.storyId })),
      ],
      movedParents,
      taskOrders,
    ),
  );
  const taskPlaces = $derived(placesOf(taskLists));
  const rootRows = $derived(taskLists[ROOT] ?? []);

  // ドラッグの判定に渡す、今の木の並び（画面で動かした並びを含む）
  const dropIndex = $derived(
    indexTree({
      openEpics: epics.filter((epic) => epic.completed_at === null && epic.canceled_at === null).map((epic) => epic.id),
      storyLists: Object.fromEntries(
        Object.entries(storyLists).map(([key, list]) => [
          key,
          list.map((story) => ({ id: story.id, open: story.completed_at === null })),
        ]),
      ),
      taskLists: Object.fromEntries(Object.entries(taskLists).map(([key, list]) => [key, list.map((task) => task.id)])),
    }),
  );
  const dnd = new BacklogDnd({
    index: () => dropIndex,
    enabled: () => canWrite,
    onDrop: (drop) => (drop.move.kind === 'task' ? dropTask(drop.move) : dropStory(drop.move)),
  });
  // 木の行へ渡す。書き込めないときは渡さず、つまみも落とし先も出さない
  const rowDnd = $derived(canWrite ? dnd : undefined);
  $effect(() => dnd.monitor());
  // 読み直したら、つかんでいるドラッグは取りやめる（離しても何も送らない）。印と光らせる行も捨てる
  $effect.pre(() => {
    void tree;
    dnd.reset();
  });
  // 親なしのタスクの折りたたみの行は、親なしの末尾の落とし先
  const rootTail: DropRow = { kind: 'tail', parent: 'root', id: ROOT };

  function storyRows(story: BacklogStory): BacklogTask[] {
    return taskLists[story.id] ?? [];
  }

  // 配下の未完了のタスクの件数。画面で完了にした行は数えない（読み直すまで行は残るが、完了している）
  function remainingOf(story: BacklogStory): number {
    return storyRows(story).filter((task) => !completedIds.includes(task.id)).length;
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

  // エピックの合計は、今その下に並ぶストーリーの合計（画面で移したストーリーと、足した行、完了にした行の分を含む）
  function epicStories(epic: BacklogEpic): BacklogStory[] {
    return storyLists[epic.id] ?? [];
  }
  function epicPoints(epic: BacklogEpic): { done: number; all: number } {
    const stories = epicStories(epic);
    return {
      done: stories.reduce((sum, story) => sum + pointsDoneOf(story), 0),
      all: stories.reduce((sum, story) => sum + pointsAllOf(story), 0),
    };
  }

  // 送っている操作の読み上げ。タスクの完了、ストーリーの完了、ストーリーの取り消しの順に、送っているものを1つ選ぶ
  const completingStatus = $derived.by(() => {
    const storyActions = Object.values(storyPending);
    if (pendingIds.length > 0) return t('taskCompleting', { done: t('done') });
    if (storyActions.includes('complete')) return t('storyCompleting', { done: t('done') });
    if (storyActions.includes('reopen')) return t('storyReopening', { done: t('done') });
    return '';
  });
  let taskDialog = $state<ReturnType<typeof TaskCreateDialog>>();
  let storyDialog = $state<ReturnType<typeof StoryDialog>>();
  let epicDialog = $state<ReturnType<typeof EpicDialog>>();
  // 完了にした行の完了の印へフォーカスを移すために持つ。描き直しには使わない
  const entries: Record<string, ReturnType<typeof TaskEntry> | undefined> = {};
  // ストーリーとエピックの行。起票した親の行を開く、完了の後にフォーカスを戻すために持つ
  const treeRows: Record<string, ReturnType<typeof TreeStory> | undefined> = {};
  const epicRows: Record<string, ReturnType<typeof TreeEpic> | undefined> = {};

  // ストーリーの行と、その親のエピックの行を開く
  function expandStory(storyId: string): void {
    treeRows[storyId]?.expand();
    const epicId = storyPlaces[storyId]?.parentId;
    if (epicId != null) epicRows[epicId]?.expand();
  }

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

  // 断られたストーリーの完了と取り消しの理由。409 の conflict は、サーバーが details.reason に載せた理由で分ける。
  // reload が偽の失敗（通信、5xx）は、読み直さずに知らせる
  function completionFailureMessage(
    result: { status: number; error: { code: string; details?: unknown } | null },
    action: 'complete' | 'reopen',
  ): { message: string; reload: boolean } {
    const failed = action === 'complete' ? t('storyCompleteFailed', { done: t('done') }) : t('storyReopenFailed');
    if (result.status === 404) return { message: t('storyGone', { story: t('story') }), reload: true };
    if (result.status !== 409) return { message: failed, reload: false };
    if (result.error?.code === 'workspace_closed') {
      return { message: t('workspaceClosedReadOnly', { workspace: t('workspace') }), reload: true };
    }
    const words = { story: t('story'), task: t('task'), epic: t('epic'), done: t('done') };
    switch (storyCompletionConflictReasonOf(result.error?.details)) {
      case 'open_tasks':
        return { message: t('storyOpenTasks', words), reload: true };
      case 'completed':
        return { message: t('storyAlreadyDone', words), reload: true };
      case 'not_completed':
        return { message: t('storyNotDone', words), reload: true };
      case 'parent_completed':
        return {
          message: action === 'complete' ? t('storyCompleteParentDone', words) : t('storyReopenParentDone', words),
          reload: true,
        };
      case 'changed':
        return { message: t('storyCompletionChanged'), reload: true };
      default:
        return { message: failed, reload: true };
    }
  }

  // ストーリーを完了にする、取り消す。通ったら木を読み直し、作り直した行の操作（取り消すか完了にする）へフォーカスを移す
  async function setStoryCompletion(story: BacklogStory, action: 'complete' | 'reopen'): Promise<void> {
    if (workspace === null || Object.hasOwn(storyPending, story.id)) return;
    storyPending = { ...storyPending, [story.id]: action };
    const workspaceId = workspace.id;
    try {
      const input = { workspace_id: workspaceId, story_id: story.id };
      const options = { slug: page.params.slug ?? '' };
      const result =
        action === 'complete'
          ? await callOperation(storyComplete, input, options)
          : await callOperation(storyReopen, input, options);
      if (workspaceId !== page.params.id) return;
      if (!result.ok && result.status === 401) {
        await invalidateAll();
        return;
      }
      if (result.ok) {
        showToast(
          action === 'complete'
            ? t('storyCompleted', { story: t('story'), done: t('done') })
            : t('storyReopened', { story: t('story'), done: t('done') }),
          'check',
        );
      } else {
        const failure = completionFailureMessage(result, action);
        showToast(failure.message, 'alert');
        if (!failure.reload) return;
      }
      await invalidateAll();
      await tick();
      // 行が消えていたら（読み直した木に無ければ）、見出しへ移す
      const row = treeRows[story.id];
      if (row) row.focusCompletion();
      else document.querySelector<HTMLElement>('h1.page-title')?.focus();
    } finally {
      storyPending = Object.fromEntries(Object.entries(storyPending).filter(([id]) => id !== story.id));
    }
  }

  function created(task: BacklogTask, storyId: string | null): void {
    added = [...added, { task, storyId }];
    // 畳まれている親の行は開いて、足した行が見えるようにする
    if (storyId !== null) expandStory(storyId);
  }

  // 直す対象のストーリーかエピックが消えていた。木を読み直し、フォーカスを見出しへ移す（ダイアログが閉じて、戻る先が無いため）
  async function rowGone(): Promise<void> {
    await invalidateAll();
    await tick();
    document.querySelector<HTMLElement>('h1.page-title')?.focus();
  }

  let moveDialog = $state<ReturnType<typeof MoveParentDialog<BacklogTask>>>();
  let storyMoveDialog = $state<ReturnType<typeof MoveParentDialog<BacklogStory>>>();
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
    movedStoryParents = {};
    storyOrders = {};
    moves.discard();
  }

  // 木を読み直す。読み直しが失敗しても、送れなかった並びを出し続けない
  async function reloadTree(): Promise<void> {
    try {
      await invalidateAll();
    } finally {
      discardMoves();
    }
  }

  // 失敗した移動の理由。409 の conflict は、サーバーが details.reason に載せた理由で分ける。
  // 親が完了していたときの文は、動かした行がタスク（親はストーリー）かストーリー（親はエピック）かで変える
  function moveFailureMessage(
    result: { status: number; error: { code: string; details?: unknown } | null },
    kind: 'task' | 'story',
  ): string {
    if (result.status === 404) return t('moveGone');
    if (result.status !== 409) return t('moveFailed');
    if (result.error?.code === 'workspace_closed') return t('workspaceClosedReadOnly', { workspace: t('workspace') });
    switch (moveConflictReasonOf(result.error?.details)) {
      case 'parent_completed':
        return kind === 'task'
          ? t('moveParentDone', { done: t('done'), story: t('story') })
          : t('moveEpicDone', { done: t('done'), epic: t('epic') });
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

  // 動かす操作を、押した順に送る。失敗したら理由を知らせて読み直し、フォーカスを同じ操作（無ければ見出し）へ戻す
  function send(call: () => Promise<ApiResult<unknown>>, kind: 'task' | 'story'): void {
    const workspaceId = workspace?.id;
    void moves.send(call, async (result) => {
      // 送っている間に別のワークスペースへ移っていたら、古い応答で状態を触らない
      if (result.ok || workspaceId !== page.params.id) return;
      // 401 は、枠の読み直しがログインの画面へ移す
      if (result.status !== 401) showToast(moveFailureMessage(result, kind), 'alert');
      const saved = focusedControl();
      const lost = document.activeElement === null || document.activeElement === document.body;
      await reloadTree();
      await restoreFocus(saved, lost);
    });
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
    send(() => callOperation(taskMove, input, { slug: page.params.slug ?? '' }), 'task');
  }

  function reorderStory(story: BacklogStory, delta: -1 | 1): void {
    if (workspace === null) return;
    const parentId = storyPlaces[story.id]?.parentId ?? null;
    const key = parentId ?? ROOT;
    const next = shifted(
      (storyLists[key] ?? []).map((row) => row.id),
      story.id,
      delta,
    );
    if (next === null) {
      void announce(delta < 0 ? t('moveAtTop') : t('moveAtBottom'));
      return;
    }
    const restore = holdFocus();
    storyOrders = { ...storyOrders, [key]: next.ids };
    void restore();
    void announce(t('moveAnnounced', { title: story.title, index: next.index + 1 }));
    const input = { workspace_id: workspace.id, story_id: story.id, epic_id: parentId, after_story_id: next.after };
    send(() => callOperation(storyMove, input, { slug: page.params.slug ?? '' }), 'story');
  }

  function openMoveDialog(task: BacklogTask, trigger: HTMLElement): void {
    moveDialog?.show(trigger, task, taskPlaces[task.id]?.parentId ?? null);
  }

  function openStoryMoveDialog(story: BacklogStory, trigger: HTMLElement): void {
    storyMoveDialog?.show(trigger, story, storyPlaces[story.id]?.parentId ?? null);
  }

  // 親を移す（ダイアログが閉じた後に呼ばれる）。移す先の末尾に置き（API には直前の行を送らない）、畳まれていれば開く。
  // 行は移す先の下に作り直されるので、新しい行の「親を移す」へフォーカスを移す
  function moveParent(task: BacklogTask, storyId: string | null): void {
    if (workspace === null) return;
    const key = storyId ?? ROOT;
    const ids = (taskLists[key] ?? []).map((row) => row.id).filter((id) => id !== task.id);
    movedParents = { ...movedParents, [task.id]: storyId };
    taskOrders = { ...taskOrders, [key]: [...ids, task.id] };
    if (storyId !== null) expandStory(storyId);
    void tick().then(() => entries[task.id]?.focusMoveParent());
    void announce(taskParentAnnouncement(task, storyId));
    const input = { workspace_id: workspace.id, task_id: task.id, story_id: storyId };
    send(() => callOperation(taskMove, input, { slug: page.params.slug ?? '' }), 'task');
  }

  // 親を移して末尾に置いたときの読み上げ
  function taskParentAnnouncement(task: BacklogTask, storyId: string | null): string {
    const parent = storyId === null ? undefined : allStories.find((story) => story.id === storyId);
    // 親のストーリーがエピックの下なら、エピックの題も添える（同じ題のストーリーが、別のエピックの下にありうるため）
    const parentEpic = storyId === null ? undefined : parentEpicOf(storyId);
    if (parent === undefined) return t('moveAnnouncedRoot', { title: task.title });
    if (parentEpic === undefined) {
      return t('moveAnnouncedUnder', { title: task.title, story: t('story'), parent: parent.title });
    }
    return t('moveAnnouncedUnderEpic', {
      title: task.title,
      epic: t('epic'),
      epicTitle: parentEpic.title,
      story: t('story'),
      parent: parent.title,
    });
  }

  function storyParentAnnouncement(story: BacklogStory, epicId: string | null): string {
    const parent = epicId === null ? undefined : epics.find((epic) => epic.id === epicId);
    return parent === undefined
      ? t('moveAnnouncedRoot', { title: story.title })
      : t('moveAnnouncedUnder', { title: story.title, story: t('epic'), parent: parent.title });
  }

  // つまみのドラッグで落とした。ボタンの並べ替えと同じく、先に画面を動かしてから送る。
  // 親を移して末尾に置いたときは移した先を、それ以外は何番目かを読み上げる。行は動くが、フォーカスは動かさない（マウスの操作）。
  // 落とした行は光らせる。畳まれた親は開く。直前の行は、末尾に置くときだけ省く
  function dropTask(move: DropMove): void {
    if (workspace === null) return;
    const task = Object.values(taskLists)
      .flat()
      .find((row) => row.id === move.id);
    if (task === undefined) return;
    const key = move.parentId ?? ROOT;
    const next = (taskLists[key] ?? []).map((row) => row.id).filter((id) => id !== task.id);
    next.splice(move.index, 0, task.id);
    movedParents = { ...movedParents, [task.id]: move.parentId };
    taskOrders = { ...taskOrders, [key]: next };
    if (move.parentId !== null) expandStory(move.parentId);
    dnd.flash({ kind: 'task', id: task.id });
    void announce(
      move.atEnd && move.reparent
        ? taskParentAnnouncement(task, move.parentId)
        : t('moveAnnounced', { title: task.title, index: move.index + 1 }),
    );
    const input = {
      workspace_id: workspace.id,
      task_id: task.id,
      story_id: move.parentId,
      ...(move.afterId === undefined ? {} : { after_task_id: move.afterId }),
    };
    send(() => callOperation(taskMove, input, { slug: page.params.slug ?? '' }), 'task');
  }

  function dropStory(move: DropMove): void {
    if (workspace === null) return;
    const story = allStories.find((row) => row.id === move.id);
    if (story === undefined) return;
    const key = move.parentId ?? ROOT;
    const next = (storyLists[key] ?? []).map((row) => row.id).filter((id) => id !== story.id);
    next.splice(move.index, 0, story.id);
    movedStoryParents = { ...movedStoryParents, [story.id]: move.parentId };
    storyOrders = { ...storyOrders, [key]: next };
    if (move.parentId !== null) epicRows[move.parentId]?.expand();
    dnd.flash({ kind: 'story', id: story.id });
    void announce(
      move.atEnd && move.reparent
        ? storyParentAnnouncement(story, move.parentId)
        : t('moveAnnounced', { title: story.title, index: move.index + 1 }),
    );
    const input = {
      workspace_id: workspace.id,
      story_id: story.id,
      epic_id: move.parentId,
      ...(move.afterId === undefined ? {} : { after_story_id: move.afterId }),
    };
    send(() => callOperation(storyMove, input, { slug: page.params.slug ?? '' }), 'story');
  }

  // ストーリーの親（エピック）を移す。タスクの親を移すのと同じ形
  function moveStoryParent(story: BacklogStory, epicId: string | null): void {
    if (workspace === null) return;
    const key = epicId ?? ROOT;
    const ids = (storyLists[key] ?? []).map((row) => row.id).filter((id) => id !== story.id);
    movedStoryParents = { ...movedStoryParents, [story.id]: epicId };
    storyOrders = { ...storyOrders, [key]: [...ids, story.id] };
    if (epicId !== null) epicRows[epicId]?.expand();
    void tick().then(() => treeRows[story.id]?.focusMoveParent());
    void announce(storyParentAnnouncement(story, epicId));
    const input = { workspace_id: workspace.id, story_id: story.id, epic_id: epicId };
    send(() => callOperation(storyMove, input, { slug: page.params.slug ?? '' }), 'story');
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
    showCategory={place?.parentId == null}
    dnd={rowDnd}
  />
{/snippet}

{#snippet storyRow(story: BacklogStory)}
  {@const place = storyPlaces[story.id]}
  {@const epic = parentEpicOf(story.id)}
  <!-- 親のないストーリーは、移す先のエピックがあるときだけ「親を移す」を出す（エピックの下のストーリーは、親なしへ移せる）。
       完了か中止したエピックの下では、完了と取り消しは必ず断られるので、押せない理由を出す -->

  <TreeStory
    bind:this={treeRows[story.id]}
    {story}
    tasks={storyRows(story)}
    pointsDone={pointsDoneOf(story)}
    pointsAll={pointsAllOf(story)}
    {clock}
    {canWrite}
    nested={place?.parentId != null}
    remaining={remainingOf(story)}
    pending={Object.hasOwn(storyPending, story.id)}
    parentFinished={epic !== undefined && (epic.completed_at !== null || epic.canceled_at !== null)}
    onComplete={canWrite ? (target) => void setStoryCompletion(target, 'complete') : undefined}
    onReopen={canWrite ? (target) => void setStoryCompletion(target, 'reopen') : undefined}
    onEdit={(target, trigger) => storyDialog?.show(trigger, target.id)}
    onAddTask={(target, trigger) => taskDialog?.show(trigger, target.id)}
    row={taskRow}
    canMoveUp={place !== undefined && place.index > 0}
    canMoveDown={place !== undefined && place.index < place.count - 1}
    onMove={canWrite ? reorderStory : undefined}
    onMoveParent={canWrite && (place?.parentId != null || openEpics.length > 0) ? openStoryMoveDialog : undefined}
    dnd={rowDnd}
  />
{/snippet}

{#if workspace && tree === null}
  <LoadFailed inShell />
{:else if workspace && tree}
  <!-- チーム全体の経験値は、読めたときだけ見出しの中に出す（読めなくても画面は開く） -->
  {#snippet teamExperience()}
    {#if data.teamTotal !== null}<TeamExperience total={data.teamTotal} />{/if}
  {/snippet}
  <PageHead
    title={t('backlog')}
    eyebrow={workspace.name}
    focusable
    meta={data.teamTotal === null ? undefined : teamExperience}
  >
    {#snippet actions()}
      {#if canWrite}
        <button class="btn" type="button" onclick={(event) => epicDialog?.show(event.currentTarget)}>
          <Icon name="plus" />{t('epicCreate', { epic: t('epic') })}
        </button>
        <button class="btn" type="button" onclick={(event) => storyDialog?.show(event.currentTarget)}>
          <Icon name="plus" />{t('storyCreate', { story: t('story') })}
        </button>
        <button class="btn is-primary" type="button" onclick={(event) => taskDialog?.show(event.currentTarget)}>
          <Icon name="plus" />{t('create')}
        </button>
      {/if}
    {/snippet}
  </PageHead>

  <!-- 完成の定義（components.css の .dod）。木の上に1つだけ畳んで置き、行ごとには繰り返さない。空なら出さない。
       本文は開くまで描かない（長い定義の変換と描画を、開かない人に払わせない） -->
  {#if workspace.definitionOfDone !== null}
    <details class="dod" bind:open={dodOpen}>
      <summary>{t('dod')}</summary>
      {#if dodOpen}<Markdown source={workspace.definitionOfDone} headingStart={2} />{/if}
    </details>
  {/if}

  <!-- 完了の操作を送っている最中の読み上げと、動かした結果の読み上げ。領域は常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{completingStatus}</span>
  <span class="visually-hidden" role="status">{moveStatus}</span>

  {#if epics.length === 0 && tree.stories.length === 0 && rootRows.length === 0 && tree.completed_count === 0}
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
        <p class="action-note">{t('backlogOrderNote', { story: t('story'), task: t('task') })}</p>
      {/if}
      <div class="tree">
        {#each epics as epic (epic.id)}
          {@const points = epicPoints(epic)}
          <TreeEpic
            bind:this={epicRows[epic.id]}
            {epic}
            pointsDone={points.done}
            pointsAll={points.all}
            {clock}
            empty={epicStories(epic).length === 0}
            dnd={rowDnd}
            onEdit={(target, trigger) => epicDialog?.show(trigger, target.id)}
          >
            {#each epicStories(epic) as story (story.id)}
              {@render storyRow(story)}
            {/each}
          </TreeEpic>
        {/each}
        {#each rootStoryList as story (story.id)}
          {@render storyRow(story)}
        {/each}
        {#if rootRows.length > 0 || tree.completed_count > 0}
          <div>
            {#if rootRows.length === 0 && epics.length === 0 && tree.stories.length === 0}
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
              <p class="tree-folded is-root" data-drop={rowDnd?.markOf(rootTail)} {@attach rowDnd?.target(rootTail)}>
                {t('backlogFolded', { done: t('done'), count: tree.completed_count })}
              </p>
            {/if}
          </div>
        {/if}
      </div>
    </section>
  {/if}

  <!-- エピックとストーリーのダイアログは、閉じたワークスペースでも読み取り専用で開く -->
  <EpicDialog
    bind:this={epicDialog}
    slug={page.params.slug ?? ''}
    workspaceId={workspace.id}
    {canWrite}
    categories={data.definitions?.categories ?? []}
    categoriesFailed={data.definitions === null}
    onsaved={() => void invalidateAll()}
    ongone={() => void rowGone()}
  />
  <StoryDialog
    bind:this={storyDialog}
    slug={page.params.slug ?? ''}
    workspaceId={workspace.id}
    {canWrite}
    categories={data.definitions?.categories ?? []}
    categoriesFailed={data.definitions === null}
    onsaved={() => void invalidateAll()}
    ongone={() => void rowGone()}
  />
  {#if canWrite}
    <TaskCreateDialog
      bind:this={taskDialog}
      slug={page.params.slug ?? ''}
      workspaceId={workspace.id}
      stories={openStories}
      categories={data.definitions?.categories ?? []}
      repositories={data.definitions?.repositories ?? []}
      definitionsFailed={data.definitions === null}
      oncreated={created}
    />
    <MoveParentDialog bind:this={moveDialog} parents={openStories} onmove={moveParent} />
    <MoveParentDialog bind:this={storyMoveDialog} parents={openEpics} onmove={moveStoryParent} />
  {/if}
{/if}
