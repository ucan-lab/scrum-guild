<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { backlogCompletedTasks } from '../../shared/operations/task/backlog-completed-tasks.ts';
  import { callOperation } from '../api.ts';
  import { CompletedBacklog } from '../completed-backlog.svelte.ts';
  import type { BacklogDnd } from '../backlog-dnd.svelte.ts';
  import type { DropRow } from '../backlog-drop.ts';
  import { drawerState, openTaskTab, taskDetailHref } from '../drawer.svelte.ts';
  import { formatLocalDate } from '../format.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';

  // 完了の折りたたみ（親のないタスクと、ストーリーの配下）。kit.js の completedTasks。
  // 閉じているときは「<完了> N 件を折りたたんでいます」の開閉のボタン（落とし先を兼ねる）。開くと backlog-completed-tasks で
  // 新しい順に20件ずつ読み、「さらに見る」で続ける。開いた状態は部品の中に持ち、閉じると読んだ一覧を捨てる（開き直すと先頭の20件から）。
  // 開く操作の中で読み込みを始め、開いた時点で loading を真にする（空の案内を一瞬も出さないため）。
  // revision（木の読み直しのたびに替わる）が替わったら、開いていれば出していた件数ぶんを先頭から読み直す。
  // 題は引き出しを開くボタンで、閉じたときのフォーカスの戻し先は +layout.svelte が data-task-id で探す。
  // 完了した行はつかめず、完了の丸も無い。落とし先にするのは開閉のボタンだけ（前後は配下の末尾）。
  // storyTitle はストーリーの配下のとき、開閉のボタンと一覧の読み上げの名前に添える（親のないタスクは添えない）
  let {
    slug,
    workspaceId,
    storyId = null,
    storyTitle,
    count,
    revision,
    root = false,
    dnd,
    tailRow,
  }: {
    slug: string;
    workspaceId: string;
    storyId?: string | null;
    storyTitle?: string;
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

  let toggleButton = $state<HTMLButtonElement>();
  let listElement = $state<HTMLElement>();
  let retryButton = $state<HTMLButtonElement>();

  let seenRevision = untrack(() => revision);
  $effect(() => {
    const current = revision;
    if (current === seenRevision) return;
    seenRevision = current;
    if (untrack(() => expanded)) untrack(() => void list.refresh());
  });
  $effect(() => () => list.cancel());

  function toggle(): void {
    expanded = !expanded;
    if (expanded) void list.refresh();
    else list.reset();
  }

  function open(id: string): void {
    const url = new URL(page.url.href);
    url.searchParams.set('task', id);
    const href = taskDetailHref(url.href);
    if (drawerState.mode === 'tab') {
      openTaskTab(href);
      return;
    }
    // ページ全体は別の画面へ移るので、先頭から読む（一覧のスクロールを持ち越さない）
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- page.url は SvelteKit が解決済み。現在の経路の問い合わせだけを変える
    void goto(href, drawerState.mode === 'page' ? {} : { reset: false });
  }

  // 押したボタン（「さらに見る」「もう一度試す」）が読み終えて消えたら、フォーカスが body に落ちる。
  // 失敗したなら新しい「もう一度試す」へ、読めたなら新しく並んだ先頭の行の題（無ければ開閉のボタン）へ移す。from は新しく並んだ先頭の添字
  async function keepFocus(control: HTMLElement, from: number): Promise<void> {
    await tick();
    if (control.isConnected) return;
    if (list.failed && retryButton) {
      retryButton.focus();
      return;
    }
    const id = list.tasks[from]?.id;
    const title =
      id === undefined ? null : listElement?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id)}"]`);
    (title ?? toggleButton)?.focus();
  }

  async function more(event: MouseEvent & { currentTarget: HTMLButtonElement }): Promise<void> {
    const control = event.currentTarget;
    const from = list.tasks.length;
    await list.more();
    await keepFocus(control, from);
  }

  async function retry(event: MouseEvent & { currentTarget: HTMLButtonElement }): Promise<void> {
    const control = event.currentTarget;
    const from = list.retryAppends ? list.tasks.length : 0;
    await list.retry();
    await keepFocus(control, from);
  }

  const label = $derived(
    t(expanded ? (root ? 'completedRootCollapse' : 'completedCollapse') : root ? 'backlogFolded' : 'storyFolded', {
      done: t('done'),
      count,
    }),
  );
  const toggleName = $derived(
    storyTitle === undefined ? undefined : t('completedToggleLabel', { label, title: storyTitle }),
  );
  const listName = $derived(
    storyTitle === undefined
      ? t('completedRootListLabel', { done: t('done'), task: t('task') })
      : t('completedListLabel', { title: storyTitle, done: t('done'), task: t('task') }),
  );
</script>

<button
  bind:this={toggleButton}
  class="tree-folded"
  class:is-root={root}
  type="button"
  aria-expanded={expanded}
  aria-controls={bodyId}
  aria-label={toggleName}
  data-drop={dnd?.markOf(tailRow)}
  {@attach dnd?.target(tailRow)}
  onclick={toggle}
>
  <Icon name="chevron" />
  {label}
</button>
<div
  id={bodyId}
  bind:this={listElement}
  class="completed-list"
  role="group"
  aria-label={listName}
  hidden={!expanded}
  aria-busy={list.loading}
>
  {#if expanded}
    {#each list.tasks as task (task.id)}
      <div class="entry" data-row-id={task.id}>
        <span aria-hidden="true"></span>
        <div class="entry-main">
          <button class="entry-title" type="button" data-task-id={task.id} onclick={() => open(task.id)}
            >{task.title}</button
          >
          <span class="entry-meta"
            ><time datetime={task.completed_at}
              >{t('completedDate', { done: t('done') })}
              <span class="mono">{formatLocalDate(task.completed_at)}</span></time
            ></span
          >
        </div>
        <div class="entry-end">
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
          {#if task.assignee === null}
            <Avatar userId={null} />
          {:else}
            <Avatar userId={task.assignee.id} name={task.assignee.name} />
          {/if}
        </div>
      </div>
    {/each}
  {/if}
  <!-- 常に置いた領域の中身だけを替える（読み上げが、挿入された要素を拾い損ねないように） -->
  <p class="completed-status" role="status">{expanded && list.loading ? t('loading') : ''}</p>
  {#if expanded}
    {#if list.failed}
      <div class="completed-status">
        <p role="alert">{t('loadFailedTitle')}</p>
        <button bind:this={retryButton} class="btn is-sm" type="button" onclick={retry}>{t('retry')}</button>
      </div>
    {:else if !list.loading && list.tasks.length === 0}
      <p class="completed-status">{t('completedEmpty', { done: t('done'), task: t('task') })}</p>
    {/if}
    {#if list.next !== null && !list.failed}
      <div class="completed-status">
        <button class="btn is-sm" type="button" aria-disabled={list.loading} onclick={more}>{t('completedMore')}</button
        >
      </div>
    {/if}
  {/if}
</div>
