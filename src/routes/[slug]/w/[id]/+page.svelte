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
  // 見出しはワークスペースの名前。閉じていれば、閉じた日を印で出し、起票と完了の操作は出さない。
  // 完了にした行は、読み直すまで完了の印を付けてその場に残す。件数は読み直した値なので、その行は読み直すまで入らない。
  // 起票したタスクは、読み直さずに一覧の末尾に足す
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
    pendingIds = [];
  });

  const rows = $derived([...(tasks ?? []), ...added]);
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
      } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
        showToast(t('workspaceClosedReadOnly', { workspace: t('workspace') }), 'alert');
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
    <title>{t('pageTitle', { page: workspace.name, app: t('appName') })}</title>
  {/if}
</svelte:head>

{#if workspace && tasks === null}
  <LoadFailed inShell />
{:else if workspace}
  <PageHead title={workspace.name} eyebrow={t('backlog')} focusable>
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
