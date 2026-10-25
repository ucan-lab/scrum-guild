<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { BacklogStory, BacklogTask } from '../../shared/operations/task/backlog-tree.ts';
  import { t } from '../vocabulary.svelte.ts';
  import DueChip from './DueChip.svelte';
  import Icon from './Icon.svelte';

  // kit.js の treeStory（バックログの木のストーリーの行と、配下）。親のないストーリーの行。
  // 行は普通の要素で、開閉は左端の caret のボタン（aria-expanded と aria-controls）だけが受け持つ。
  // 題を押すとストーリーのダイアログ（onEdit）、「＋タスク」を押すと親を選んだタスクのダイアログ（onAddTask）を開く。
  // この3つは独立したボタンなので、押しても行は開閉しない。開閉の状態は部品の中に持ち、expand() で開ける（起票した親を開く）。
  // 閉じたワークスペース（canWrite が偽）と、完了したストーリーには「＋タスク」を出さない（題は読み取り専用で開く）。
  // 完了したストーリーの期日には色を付けない。
  // tasks は未完了の行（画面が足した行を含む）。pointsDone と pointsAll は、画面が足した行と完了にした行の分を含む合計。
  // 配下のタスクの行は row の snippet で描く（完了の操作は画面の側が持つ）
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
  } = $props();

  const bodyId = $props.id();
  let expanded = $state(true);
  const finished = $derived(story.completed_at !== null);

  export function expand(): void {
    expanded = true;
  }
</script>

<div class="tree-group">
  <div class="tree-row is-story is-root">
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
