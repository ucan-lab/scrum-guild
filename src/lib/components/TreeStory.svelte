<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { BacklogStory, BacklogTask } from '../../shared/operations/task/backlog-tree.ts';
  import { t } from '../vocabulary.svelte.ts';
  import DueChip from './DueChip.svelte';
  import Icon from './Icon.svelte';

  // kit.js の treeStory（バックログの木のストーリーの行と、配下）。親のないストーリーの行と、エピックの下のストーリーの行（nested）。
  // 行は普通の要素で、開閉は左端の caret のボタン（aria-expanded と aria-controls）だけが受け持つ。
  // 題を押すとストーリーのダイアログ（onEdit）、「＋タスク」を押すと親を選んだタスクのダイアログ（onAddTask）を開く。
  // この3つは独立したボタンなので、押しても行は開閉しない。開閉の状態は部品の中に持ち、expand() で開ける（起票した親を開く）。
  // 閉じたワークスペース（canWrite が偽）と、完了したストーリーには「＋タスク」を出さない（題は読み取り専用で開く）。
  // 完了したストーリーの期日には色を付けない。
  // tasks は未完了の行（画面が足した行を含む）。pointsDone と pointsAll は、画面が足した行と完了にした行の分を含む合計。
  // 配下のタスクの行は row の snippet で描く（完了の操作は画面の側が持つ）。
  // onComplete を渡すと（書き込めるとき）、完了していないストーリーに「完了にする」を出す。配下の未完了のタスク（remaining。
  // 画面で完了にした行は数えない）が残るあいだは、押しても何も起きない aria-disabled にして、横に「残り N 件」を出す。
  // 完了したストーリーには完了の印（.hanko）を付け、onReopen を渡すと「取り消す」を出す。送っている間（pending）は、どちらも aria-disabled。
  // onMove を渡すと（書き込めるとき）、行の右端に「上へ」「下へ」を出し、ストーリーの行の中で Alt と ↑ ↓ を押しても同じことをする。
  // キーは配下のタスクの行には掛けない（タスクの行は自分で受け持つ）。端の向きは aria-disabled にする。
  // onMoveParent を渡すと「親を移す」（親のエピックを選ぶダイアログ）も出す
  let {
    story,
    tasks,
    pointsDone,
    pointsAll,
    clock,
    canWrite,
    onEdit,
    onAddTask,
    row,
    nested = false,
    remaining = 0,
    pending = false,
    onComplete,
    onReopen,
    canMoveUp = false,
    canMoveDown = false,
    onMove,
    onMoveParent,
  }: {
    story: BacklogStory;
    tasks: readonly BacklogTask[];
    pointsDone: number;
    pointsAll: number;
    clock: { today: string; weekStart: number };
    canWrite: boolean;
    onEdit: (story: BacklogStory, trigger: HTMLElement) => void;
    onAddTask: (story: BacklogStory, trigger: HTMLElement) => void;
    row: Snippet<[BacklogTask]>;
    nested?: boolean;
    remaining?: number;
    pending?: boolean;
    onComplete?: (story: BacklogStory) => void;
    onReopen?: (story: BacklogStory) => void;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
    onMove?: (story: BacklogStory, delta: -1 | 1) => void;
    onMoveParent?: (story: BacklogStory, trigger: HTMLElement) => void;
  } = $props();

  function move(delta: -1 | 1): void {
    if (delta < 0 ? !canMoveUp : !canMoveDown) return;
    onMove?.(story, delta);
  }

  function keydown(event: KeyboardEvent): void {
    if (onMove === undefined || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    // 端でも画面に渡す（画面が、動かせないことを読み上げる）
    onMove(story, event.key === 'ArrowUp' ? -1 : 1);
  }

  const bodyId = $props.id();
  const remainingId = `${bodyId}-remaining`;
  let expanded = $state(true);
  const finished = $derived(story.completed_at !== null);

  export function expand(): void {
    expanded = true;
  }

  // 完了と取り消しの後は木を読み直すので、画面が新しい行の操作へフォーカスを移すのに使う
  let completeButton = $state<HTMLButtonElement>();
  let reopenButton = $state<HTMLButtonElement>();
  let mark = $state<HTMLElement>();
  let moveParentButton = $state<HTMLButtonElement>();
  export function focusCompletion(): void {
    (reopenButton ?? completeButton ?? mark)?.focus();
  }
  // 親を移すと行は別の親の下に作り直されるので、画面が新しい行の「親を移す」へフォーカスを戻すのに使う
  export function focusMoveParent(): void {
    moveParentButton?.focus();
  }
</script>

<div class="tree-group">
  <!-- キーは中のボタンから届く。行そのものはフォーカスを受けない -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="tree-row is-story" class:is-root={!nested} onkeydown={keydown} data-row-id={story.id}>
    <button
      class="tree-caret"
      type="button"
      aria-expanded={expanded}
      aria-controls={bodyId}
      aria-label={expanded ? t('treeClose', { title: story.title }) : t('treeOpen', { title: story.title })}
      onclick={() => (expanded = !expanded)}
    >
      <Icon name="chevron" />
    </button>
    <span class="kind is-story" title={t('story')}><Icon name="check" /></span>
    <span class="tree-title">
      <button class="tree-link" type="button" onclick={(event) => onEdit(story, event.currentTarget)}
        >{story.title}</button
      >
      {#if story.due_on !== null}
        <DueChip dueOn={story.due_on} today={clock.today} weekStart={clock.weekStart} done={finished} />
      {/if}
    </span>
    <span class="tree-end">
      <span class="tree-ratio" title={t('treeRatioTitle', { done: t('done') })}
        >{t('treeRatio', { done: t('done'), value: pointsDone, all: pointsAll })}</span
      >
      {#if canWrite && !finished}
        <button
          class="btn is-sm"
          type="button"
          aria-label={t('storyAddTaskLabel', { task: t('task'), title: story.title })}
          onclick={(event) => onAddTask(story, event.currentTarget)}><Icon name="plus" />{t('task')}</button
        >
      {/if}
      {#if finished}
        <!-- tabindex="-1" は、取り消せないとき（閉じたワークスペース）に、完了にした後のフォーカスを置くため -->
        <span
          class="hanko"
          role="img"
          aria-label={t('doneMarkLabel', { title: story.title, done: t('done') })}
          tabindex="-1"
          bind:this={mark}
        >
          <Icon name="check" /><b>{t('doneStamp')}</b>
        </span>
        {#if onReopen !== undefined}
          <button
            class="btn is-sm is-quiet"
            type="button"
            aria-label={t('storyReopenLabel', { done: t('done'), title: story.title })}
            aria-disabled={pending}
            bind:this={reopenButton}
            onclick={() => {
              if (!pending) onReopen(story);
            }}>{t('storyReopen')}</button
          >
        {/if}
      {:else if onComplete !== undefined}
        {#if remaining > 0}
          <span class="tree-note" id={remainingId} title={t('storyRemainingNote', { task: t('task'), done: t('done') })}
            >{t('storyRemaining', { count: remaining })}</span
          >
        {/if}
        <button
          class="btn is-sm"
          type="button"
          aria-label={t('storyCompleteLabel', { complete: t('complete'), title: story.title })}
          aria-describedby={remaining > 0 ? remainingId : undefined}
          aria-disabled={pending || remaining > 0}
          bind:this={completeButton}
          onclick={() => {
            if (!pending && remaining === 0) onComplete(story);
          }}><Icon name="check" />{t('complete')}</button
        >
      {/if}
      {#if onMove !== undefined}
        <span class="order-actions">
          <button
            class="icon-btn"
            type="button"
            aria-label={t('moveUpLabel', { title: story.title })}
            title={t('moveUp')}
            aria-disabled={!canMoveUp}
            onclick={() => move(-1)}><Icon name="up" /></button
          >
          <button
            class="icon-btn"
            type="button"
            aria-label={t('moveDownLabel', { title: story.title })}
            title={t('moveDown')}
            aria-disabled={!canMoveDown}
            onclick={() => move(1)}><Icon name="down" /></button
          >
          {#if onMoveParent !== undefined}
            <button
              class="icon-btn"
              type="button"
              aria-label={t('moveParentLabel', { title: story.title })}
              title={t('moveParent')}
              bind:this={moveParentButton}
              onclick={(event) => onMoveParent(story, event.currentTarget)}><Icon name="swap" /></button
            >
          {/if}
        </span>
      {/if}
    </span>
  </div>
  <div class="tree-children" id={bodyId} hidden={!expanded}>
    {#each tasks as task (task.id)}
      {@render row(task)}
    {/each}
    {#if story.completed_task_count > 0}
      <p class="tree-folded">{t('storyFolded', { done: t('done'), count: story.completed_task_count })}</p>
    {:else if tasks.length === 0}
      <p class="tree-folded">{t('storyNoTasks', { task: t('task') })}</p>
    {/if}
  </div>
</div>
