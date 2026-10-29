<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { backlogCompletedTasks } from '../../shared/operations/task/backlog-completed-tasks.ts';
  import { callOperation } from '../api.ts';
  import { CompletedBacklog } from '../completed-backlog.svelte.ts';
  import type { BacklogDnd } from '../backlog-dnd.svelte.ts';
  import type { DropRow } from '../backlog-drop.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  let {
    slug,
    workspaceId,
    storyId = null,
    count,
    revision,
    root = false,
    dnd,
    tailRow,
  }: {
    slug: string;
    workspaceId: string;
    storyId?: string | null;
    count: number;
    revision: unknown;
    root?: boolean;
    dnd?: BacklogDnd;
    tailRow: DropRow;
  } = $props();
  const bodyId = $props.id();
  let expanded = $state(false);
  const list = new CompletedBacklog((input) =>
    callOperation(
      backlogCompletedTasks,
      {
        workspace_id: workspaceId,
        story_id: storyId,
        ...input,
      },
      { slug },
    ),
  );
  $effect(() => {
    void revision;
    if (expanded) untrack(() => void list.refresh());
    return () => list.cancel();
  });
  let trigger: HTMLButtonElement | undefined;
  let openedId: string | undefined;
  function open(id: string, button: HTMLButtonElement): void {
    trigger = button;
    openedId = id;
    const url = new URL(page.url.href);
    url.searchParams.set('task', id);
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- page.url は SvelteKit が解決済み。現在の経路の問い合わせだけを変える
    void goto(url, { reset: false });
  }
  // 既存の引き出しはリンクへフォーカスを戻す。完了一覧の題はボタンなので、その戻り先をここで受け持つ。
  $effect(() => {
    const id = page.url.searchParams.get('task');
    if (openedId !== undefined && id !== openedId) {
      openedId = undefined;
      void tick().then(() => {
        if (id === null && page.url.searchParams.get('task') === null && trigger?.isConnected) trigger.focus();
      });
    }
  });
</script>

<button
  class="tree-folded"
  class:is-root={root}
  type="button"
  aria-expanded={expanded}
  aria-controls={bodyId}
  data-drop={dnd?.markOf(tailRow)}
  {@attach dnd?.target(tailRow)}
  onclick={() => {
    expanded = !expanded;
    if (!expanded) list.reset();
  }}
>
  <Icon name={expanded ? 'down' : 'right'} />
  {t(expanded ? (root ? 'completedRootCollapse' : 'completedCollapse') : root ? 'backlogFolded' : 'storyFolded', {
    done: t('done'),
    count,
  })}
</button>
<div id={bodyId} class="completed-list" hidden={!expanded} aria-busy={list.loading}>
  {#if expanded}
    {#each list.tasks as task (task.id)}
      <div class="entry" data-row-id={task.id}>
        <span aria-hidden="true"></span>
        <div class="entry-main">
          <button
            class="entry-title"
            type="button"
            data-task-id={task.id}
            onclick={(event) => open(task.id, event.currentTarget)}>{task.title}</button
          >
          <span class="entry-meta"
            ><time datetime={task.completed_at}
              >{t('completedDate', { date: new Date(task.completed_at).toLocaleDateString('ja-JP') })}</time
            ></span
          >
        </div>
        <div class="entry-end">
          <span
            class="pts"
            role="img"
            aria-label={task.points === null
              ? t('pointsUnsetTitle')
              : t('pointsLabel', { points: t('points'), value: task.points })}
            >{task.points ?? t('pointsUnsetMark')}</span
          >
          <span class="tree-note">{task.assignee?.name ?? t('unassigned')}</span>
        </div>
      </div>
    {/each}
    {#if list.loading}<p class="completed-status" role="status">{t('loading')}</p>{/if}
    {#if list.failed}
      <div class="completed-status">
        <p role="alert">{t('loadFailedTitle')}</p>
        <button class="btn is-sm" type="button" onclick={() => void list.retry()}>{t('retry')}</button>
      </div>
    {:else if !list.loading && list.tasks.length === 0}
      <p class="completed-status">{t('completedEmpty')}</p>
    {/if}
    {#if list.next !== null && !list.failed}
      <div class="completed-status">
        <button class="btn is-sm" type="button" aria-disabled={list.loading} onclick={() => void list.more()}
          >{t('completedMore')}</button
        >
      </div>
    {/if}
  {/if}
</div>
