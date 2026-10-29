<script lang="ts">
  import type { SprintBoardTask } from '../../shared/operations/sprint/index.ts';
  import type { MoveDirection } from '../sprint-board.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Avatar from './Avatar.svelte';
  import DefinitionChip from './DefinitionChip.svelte';
  import DueChip from './DueChip.svelte';
  import Icon from './Icon.svelte';

  // スプリントの画面のカード（kit.js の card）。題は `?task=<ID>` で詳細の引き出しを開くリンク、ポイント、担当、完了の印か完了の操作。
  // 動かせるカード（完了していない、書き込める）は tabindex="0" で選べ、中のどこにフォーカスがあっても Alt と ← → で隣の列、
  // Alt と ↑ ↓ で列の中を動かす。同じ操作を、カードの下の .order-actions のボタンでもできる。
  // 端のボタンは aria-disabled（フォーカスを失わない）で、押したり、端で Alt と矢印を押したりしても画面に渡し、動かせないことを読み上げさせる
  let {
    task,
    href,
    edges,
    canComplete,
    clock,
    pending = false,
    onmove,
    oncomplete,
  }: {
    task: SprintBoardTask;
    href: string;
    // 期日の印を決める今日（ワークスペースのタイムゾーン）と週の始まり。API の値を渡す
    clock: { today: string; weekStart: number };
    // 動かせないカード（完了の列、書き込めない）は null
    edges: { top: boolean; bottom: boolean; prev: boolean; next: boolean } | null;
    canComplete: boolean;
    pending?: boolean;
    onmove: (task: SprintBoardTask, direction: MoveDirection) => void;
    oncomplete: (task: SprintBoardTask) => void;
  } = $props();

  const done = $derived(task.completed_at !== null);
  const movable = $derived(edges !== null);
  const KEY_DIRECTIONS: Record<string, MoveDirection> = {
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ArrowUp: 'up',
    ArrowDown: 'down',
  };

  function keydown(event: KeyboardEvent): void {
    if (!movable || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const direction = KEY_DIRECTIONS[event.key];
    if (direction === undefined) return;
    event.preventDefault();
    onmove(task, direction);
  }

  const column = $derived(t('column'));
</script>

<!-- キーは中のリンクとボタンから届く。選べるのは動かせるカードだけ（tabindex は 0 か未指定だけ） -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<article
  class="card"
  class:is-done={done}
  tabindex={movable ? 0 : undefined}
  aria-label={movable ? task.title : undefined}
  data-card-id={task.id}
  onkeydown={keydown}
>
  {#if task.story !== null}
    <span class="card-parent"><Icon name="flag" /> {task.story.title}</span>
  {/if}
  <!-- 押しても、フォーカスとスクロールの位置は動かさない（引き出しが閉じたとき、data-task-id で探してフォーカスを戻す） -->
  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- href は画面が resolve した経路に ?task=<ID> を足したもの -->
  <a class="card-title" {href} data-task-id={task.id} data-sveltekit-reset="false">{task.title}</a>
  {#if task.repository !== null || task.due_on !== null}
    <div class="card-meta">
      {#if task.repository !== null}<DefinitionChip kind="repository" name={task.repository.name} />{/if}
      {#if task.due_on !== null}
        <DueChip dueOn={task.due_on} today={clock.today} weekStart={clock.weekStart} {done} />
      {/if}
    </div>
  {/if}
  <div class="card-foot">
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
    <span class="card-end">
      {#if done}
        <span class="hanko" role="img" aria-label={t('doneMarkLabel', { title: task.title, done: t('done') })}
          ><Icon name="check" /><b>{t('doneStamp')}</b></span
        >
      {:else if canComplete}
        <button
          class="done-btn"
          type="button"
          aria-label={t('taskCompleteLabel', { complete: t('complete'), title: task.title })}
          title={t('complete')}
          aria-disabled={pending}
          onclick={() => {
            if (!pending) oncomplete(task);
          }}
        >
          <Icon name="check" />
        </button>
      {/if}
    </span>
  </div>
  {#if edges !== null}
    <div class="card-moves">
      <span class="order-actions">
        <button
          class="icon-btn"
          type="button"
          aria-label={t('moveColumnPrevLabel', { column, title: task.title })}
          title={t('moveColumnPrev', { column })}
          aria-disabled={edges.prev}
          onclick={() => onmove(task, 'left')}><Icon name="left" /></button
        >
        <button
          class="icon-btn"
          type="button"
          aria-label={t('moveUpLabel', { title: task.title })}
          title={t('moveUp')}
          aria-disabled={edges.top}
          onclick={() => onmove(task, 'up')}><Icon name="up" /></button
        >
        <button
          class="icon-btn"
          type="button"
          aria-label={t('moveDownLabel', { title: task.title })}
          title={t('moveDown')}
          aria-disabled={edges.bottom}
          onclick={() => onmove(task, 'down')}><Icon name="down" /></button
        >
        <button
          class="icon-btn"
          type="button"
          aria-label={t('moveColumnNextLabel', { column, title: task.title })}
          title={t('moveColumnNext', { column })}
          aria-disabled={edges.next}
          onclick={() => onmove(task, 'right')}><Icon name="right" /></button
        >
      </span>
    </div>
  {/if}
</article>
