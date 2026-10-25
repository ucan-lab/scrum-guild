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
  import TreeStory from '../../../../lib/components/TreeStory.svelte';
  import { callOperation } from '../../../../lib/api.ts';
  import { showToast } from '../../../../lib/toast.svelte.ts';
  import { t } from '../../../../lib/vocabulary.svelte.ts';
  import type { BacklogStory, BacklogTask } from '../../../../shared/operations/task/backlog-tree.ts';
  import { taskComplete } from '../../../../shared/operations/task/index.ts';
  import type { PageProps } from './$types';

  // ワークスペースの画面（backlog.html の木と起票）。最上段は見本どおり「親のないストーリー → 親のないタスク」の2段で、
  // それぞれ position の順。ストーリーの下には未完了のタスクを並べ、完了したタスクは件数の1行にする。
  // 並べ替え、絞り込み、折りたたみを開ける操作、エピックの段は、それぞれの機能の Issue で足す。
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

  // 読み直したら（枠の読み直し、ワークスペースの切り替え）、足した行と完了の印を捨てる
  let added = $state<{ task: BacklogTask; storyId: string | null }[]>([]);
  let completedIds = $state<string[]>([]);
  let pendingIds = $state<string[]>([]);
  $effect.pre(() => {
    void tree;
    added = [];
    completedIds = [];
  });

  // 読み直した一覧と足した行が重なっても（起票の直後に読み直したときなど）、同じ id の行は1つにする
  function withAdded(base: readonly BacklogTask[], storyId: string | null): BacklogTask[] {
    const unique: Record<string, BacklogTask> = {};
    for (const task of base) unique[task.id] ??= task;
    for (const entry of added) if (entry.storyId === storyId) unique[entry.task.id] ??= entry.task;
    return Object.values(unique);
  }

  const rootRows = $derived(withAdded(tree?.tasks ?? [], null));
  const openStories = $derived((tree?.stories ?? []).filter((story) => story.completed_at === null));

  function storyRows(story: BacklogStory): BacklogTask[] {
    return withAdded(story.tasks, story.id);
  }

  // 足した行のポイントを、親の「全体」に足す。読み直した一覧にすでにある行は数えない
  function pointsAllOf(story: BacklogStory): number {
    const known = new Set(story.tasks.map((task) => task.id));
    const extra = added.filter((entry) => entry.storyId === story.id && !known.has(entry.task.id));
    return story.points_all + extra.reduce((sum, entry) => sum + (entry.task.points ?? 0), 0);
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
  <TaskEntry
    bind:this={entries[task.id]}
    {task}
    {clock}
    done={completedIds.includes(task.id)}
    pending={pendingIds.includes(task.id)}
    canComplete={canWrite}
    onComplete={complete}
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

  <!-- 完了の操作を送っている最中の読み上げ。領域は常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{completingStatus}</span>

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
      <div class="tree">
        {#each tree.stories as story (story.id)}
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
  {/if}
{/if}
