<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { BacklogStory, BacklogTask } from '../../shared/operations/task/backlog-tree.ts';
  import { t } from '../vocabulary.svelte.ts';
  import DueChip from './DueChip.svelte';
  import Icon from './Icon.svelte';

  // kit.js の treeStory（バックログの木のストーリーの行と、配下）。親のないストーリーの行。
  // 行は summary で、中に置く2つのボタン（題と「＋タスク」）は、押しても行の開閉を起こさない。
  // 題を押すとストーリーのダイアログ（onEdit）、「＋タスク」を押すと親を選んだタスクのダイアログ（onAddTask）を開く。
  // 開閉は、クリックはボタンの既定の動作を止めて避ける。キーボードの Enter と Space は summary にも届くので、
  // ボタンの上のキー入力は summary へ伝えない。閉じたワークスペース（canWrite が偽）では「＋タスク」を出さず、題は読み取り専用で開く。
  // tasks は未完了の行（画面が足した行を含む）、pointsAll は足した行のポイントを含む全体の合計。
  // 配下のタスクの行は row の snippet で描く（完了の操作は画面の側が持つ）
  let {
    story,
    tasks,
    pointsAll,
    clock,
    canWrite,
    onEdit,
    onAddTask,
    row,
  }: {
    story: BacklogStory;
    tasks: readonly BacklogTask[];
    pointsAll: number;
    clock: { today: string; weekStart: number };
    canWrite: boolean;
    onEdit: (story: BacklogStory, trigger: HTMLElement) => void;
    onAddTask: (story: BacklogStory, trigger: HTMLElement) => void;
    row: Snippet<[BacklogTask]>;
  } = $props();

  // Enter と Space は、ボタンの上で押されたものを summary（行の開閉）へ伝えない
  function keepFromSummary(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
  }
</script>

<details class="tree-group" open>
  <summary class="tree-row is-story is-root">
    <span class="tree-caret"><Icon name="chevron" /></span>
    <span class="kind is-story" title={t('story')}><Icon name="check" /></span>
    <span class="tree-title">
      <button
        class="tree-link"
        type="button"
        onclick={(event) => {
          event.preventDefault();
          onEdit(story, event.currentTarget);
        }}
        onkeydown={keepFromSummary}>{story.title}</button
      >
      {#if story.due_on !== null}
        <DueChip dueOn={story.due_on} today={clock.today} weekStart={clock.weekStart} />
      {/if}
    </span>
    <span class="tree-end">
      <span class="tree-ratio" title={t('treeRatioTitle', { done: t('done') })}
        >{t('treeRatio', { done: t('done'), value: story.points_done, all: pointsAll })}</span
      >
      {#if canWrite}
        <button
          class="btn is-sm"
          type="button"
          aria-label={t('storyAddTaskLabel', { task: t('task'), title: story.title })}
          onclick={(event) => {
            event.preventDefault();
            onAddTask(story, event.currentTarget);
          }}
          onkeydown={keepFromSummary}><Icon name="plus" />{t('task')}</button
        >
      {/if}
    </span>
  </summary>
  <div class="tree-children">
    {#each tasks as task (task.id)}
      {@render row(task)}
    {/each}
    {#if story.completed_task_count > 0}
      <p class="tree-folded">{t('storyFolded', { done: t('done'), count: story.completed_task_count })}</p>
    {:else if tasks.length === 0}
      <p class="tree-folded">{t('storyNoTasks', { task: t('task') })}</p>
    {/if}
  </div>
</details>
