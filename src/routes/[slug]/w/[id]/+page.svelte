<script lang="ts">
  import { tick } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import EmptyState from '../../../../lib/components/EmptyState.svelte';
  import Icon from '../../../../lib/components/Icon.svelte';
  import LoadFailed from '../../../../lib/components/LoadFailed.svelte';
  import PageHead from '../../../../lib/components/PageHead.svelte';
  import TaskCreateDialog from '../../../../lib/components/TaskCreateDialog.svelte';
  import TaskEntry from '../../../../lib/components/TaskEntry.svelte';
  import { callOperation } from '../../../../lib/api.ts';
  import { formatLocalDate } from '../../../../lib/format.ts';
  import { showToast } from '../../../../lib/toast.svelte.ts';
  import { t } from '../../../../lib/vocabulary.svelte.ts';
  import { taskComplete } from '../../../../shared/operations/task/index.ts';
  import type { TaskListItem } from '../../../../shared/operations/task/task-list.ts';
  import type { PageProps } from './$types';

  // ワークスペースの画面（backlog.html の一覧と起票）。今あるのは、親のない未完了のタスクの一覧、起票、完了の操作、
  // 完了した親のないタスクの件数の1行。木、並べ替え、絞り込み、折りたたみを開ける操作は、バックログと階層の Issue で足す。
  // 見出しは見本どおり画面の名前（掲示板／バックログ）で、小見出しがワークスペースの名前。
  // 閉じていれば、閉じた日を印で出し、起票と完了の操作は出さない。
  // 完了にした行は、読み直すまで完了の印を付けてその場に残す。件数は読み直した値なので、その行は読み直すまで入らない。
  // 起票したタスクは、読み直さずに一覧の末尾に足す。
  // 完了の操作を送っている最中の行（pendingIds）は、読み直しでは捨てず、応答が来たら外す
  let { data }: PageProps = $props();

  const workspace = $derived(data.workspace);
  const tasks = $derived(data.tasks);
  const canWrite = $derived(workspace !== null && workspace.closedAt === null);

  // 読み直したら（枠の読み直し、ワークスペースの切り替え）、足した行と完了の印を捨てる
  let added = $state<TaskListItem[]>([]);
  let completedIds = $state<string[]>([]);
  let pendingIds = $state<string[]>([]);
  $effect.pre(() => {
    void tasks;
    added = [];
    completedIds = [];
  });

  // 読み直した一覧と足した行が重なっても（起票の直後に読み直したときなど）、同じ id の行は1つにする
  const rows = $derived.by(() => {
    const unique: Record<string, TaskListItem> = {};
    for (const task of [...(tasks ?? []), ...added]) unique[task.id] ??= task;
    return Object.values(unique);
  });
  const completingStatus = $derived(pendingIds.length > 0 ? t('taskCompleting', { done: t('done') }) : '');
  let createDialog = $state<ReturnType<typeof TaskCreateDialog>>();
  // 完了にした行の完了の印へフォーカスを移すために持つ。描き直しには使わない
  const entries: Record<string, ReturnType<typeof TaskEntry> | undefined> = {};

  async function complete(task: TaskListItem): Promise<void> {
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
        // タスクが消えている。一覧を読み直して、行を外す
        showToast(t('taskGone', { task: t('task') }), 'alert');
        await invalidateAll();
      } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
        // 閉じた。読み直して、閉じた表示（起票と完了の操作を出さない）に切り替える
        showToast(t('workspaceClosedReadOnly', { workspace: t('workspace') }), 'alert');
        await invalidateAll();
      } else {
        showToast(t('taskCompleteFailed', { done: t('done') }), 'alert');
      }
    } finally {
      pendingIds = pendingIds.filter((id) => id !== task.id);
    }
  }

  function created(task: TaskListItem): void {
    added = [...added, task];
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

{#if workspace && tasks === null}
  <LoadFailed inShell />
{:else if workspace}
  <PageHead title={t('backlog')} eyebrow={workspace.name} focusable>
    {#snippet actions()}
      {#if workspace.closedAt}
        <span class="chip">{t('workspaceClosedChip', { date: formatLocalDate(workspace.closedAt) })}</span>
      {:else}
        <button class="btn is-primary" type="button" onclick={(event) => createDialog?.show(event.currentTarget)}>
          <Icon name="plus" />{t('create')}
        </button>
      {/if}
    {/snippet}
  </PageHead>

  <!-- 完了の操作を送っている最中の読み上げ。領域は常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{completingStatus}</span>

  {#if rows.length === 0 && data.completedCount === 0}
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
        <div>
          {#if rows.length === 0}
            <EmptyState
              icon="board"
              title={t('backlogNoOpenTitle', { task: t('task') })}
              text={canWrite
                ? t('backlogNoOpenText', { task: t('task'), create: t('create') })
                : t('backlogEmptyClosedText', { task: t('task'), workspace: t('workspace') })}
            />
          {/if}
          {#each rows as task (task.id)}
            <TaskEntry
              bind:this={entries[task.id]}
              {task}
              done={completedIds.includes(task.id)}
              pending={pendingIds.includes(task.id)}
              canComplete={canWrite}
              onComplete={complete}
            />
          {/each}
          {#if data.completedCount > 0}
            <p class="tree-folded is-root">{t('backlogFolded', { done: t('done'), count: data.completedCount })}</p>
          {/if}
        </div>
      </div>
    </section>
  {/if}

  {#if canWrite}
    <TaskCreateDialog
      bind:this={createDialog}
      slug={page.params.slug ?? ''}
      workspaceId={workspace.id}
      oncreated={created}
    />
  {/if}
{/if}
