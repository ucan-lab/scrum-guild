<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { BacklogTask } from '../../shared/operations/task/backlog-tree.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Avatar from './Avatar.svelte';
  import DueChip from './DueChip.svelte';
  import Icon from './Icon.svelte';

  // kit.js の entry（台帳の1行）と doneControl。今あるのは、タイトル（`?task=<ID>` へのリンク）、期日の印、ポイント、担当、
  // 完了の操作と完了の印。リンクは詳細の引き出しを開く（/[slug]/w/[id] のレイアウトが `?task=<ID>` を見て置く）。
  // 先頭の「今日やる」、親は、それぞれの機能の Issue で足す。先頭の枠（.entry の1列目）は、その機能が入るまで空の要素で埋める。
  // 期日の印は、API が返したワークスペースの今日の日付と週の始まり（clock）で決める。完了にした行は色を付けない。
  // 完了の操作が押されると、onComplete を呼ぶ。完了にした行は、done を真にして完了の印を付ける。
  // 押したボタンは消えるので、完了の印にフォーカスを移せるよう focusMark() を出す。
  // canComplete が偽（閉じたワークスペース）の行は、完了の操作を出さない。pending の間は押しても無視する（aria-disabled）
  // onMove を渡すと、「上へ」「下へ」（同じ親の中で1つ動かす）を出し、行の中で Alt と ↑ ↓ を押しても同じことをする。
  // 端で動かせない向き（canMoveUp、canMoveDown が偽）は、フォーカスを失わないよう disabled でなく aria-disabled にする。
  // onMoveParent を渡すと「親を移す」も出す。完了にした行には出さない
  let {
    task,
    clock,
    done = false,
    pending = false,
    canComplete = true,
    onComplete,
    canMoveUp = false,
    canMoveDown = false,
    onMove,
    onMoveParent,
  }: {
    task: BacklogTask;
    clock: { today: string; weekStart: number };
    done?: boolean;
    pending?: boolean;
    canComplete?: boolean;
    onComplete: (task: BacklogTask) => void;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
    onMove?: (task: BacklogTask, delta: -1 | 1) => void;
    onMoveParent?: (task: BacklogTask, trigger: HTMLElement) => void;
  } = $props();

  const movable = $derived(onMove !== undefined && !done);

  function move(delta: -1 | 1): void {
    if (!movable || (delta < 0 ? !canMoveUp : !canMoveDown)) return;
    onMove?.(task, delta);
  }

  // 行の中にフォーカスがあるときの Alt と ↑ ↓。端でも画面に渡す（画面が、動かせないことを読み上げる）
  function keydown(event: KeyboardEvent): void {
    if (!movable || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    onMove?.(task, event.key === 'ArrowUp' ? -1 : 1);
  }

  let mark = $state<HTMLElement>();
  // タイトルのリンクは、今のワークスペースの画面に `?task=<ID>` を付ける
  const taskHref = $derived(resolve('/[slug]/w/[id]', { slug: page.params.slug ?? '', id: page.params.id ?? '' }));

  export function focusMark(): void {
    mark?.focus();
  }

  // 親を移すと行は別の親の下に作り直されるので、画面が新しい行の「親を移す」へフォーカスを戻すのに使う
  let moveParentButton = $state<HTMLButtonElement>();
  export function focusMoveParent(): void {
    moveParentButton?.focus();
  }
</script>

<!-- キーは中のリンクとボタンから届く。行そのものはフォーカスを受けない -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- data-row-id は、画面が読み直した後に同じ行の操作へフォーカスを戻すのに使う -->
<div class="entry" class:is-done={done} onkeydown={keydown} data-row-id={task.id}>
  <span aria-hidden="true"></span>
  <div class="entry-main">
    <!-- 押しても、フォーカスとスクロールの位置は動かさない（引き出しが閉じたとき、data-task-id で探してフォーカスを戻す） -->
    <a
      class="entry-title"
      href="{taskHref}?task={encodeURIComponent(task.id)}"
      data-task-id={task.id}
      data-sveltekit-keepfocus
      data-sveltekit-noscroll>{task.title}</a
    >
  </div>
  <div class="entry-end">
    {#if task.due_on !== null}
      <DueChip dueOn={task.due_on} today={clock.today} weekStart={clock.weekStart} {done} />
    {/if}
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
    {#if movable}
      <span class="order-actions">
        <button
          class="icon-btn"
          type="button"
          aria-label={t('moveUpLabel', { title: task.title })}
          title={t('moveUp')}
          aria-disabled={!canMoveUp}
          onclick={() => move(-1)}><Icon name="up" /></button
        >
        <button
          class="icon-btn"
          type="button"
          aria-label={t('moveDownLabel', { title: task.title })}
          title={t('moveDown')}
          aria-disabled={!canMoveDown}
          onclick={() => move(1)}><Icon name="down" /></button
        >
        {#if onMoveParent !== undefined}
          <button
            class="icon-btn"
            type="button"
            aria-label={t('moveParentLabel', { title: task.title })}
            title={t('moveParent')}
            bind:this={moveParentButton}
            onclick={(event) => onMoveParent(task, event.currentTarget)}><Icon name="swap" /></button
          >
        {/if}
      </span>
    {/if}
    {#if done}
      <!-- tabindex="-1" は、完了にした後にフォーカスを置くため（キーボードの Tab 順には入らない） -->
      <span
        class="hanko is-new"
        role="img"
        aria-label={t('doneMarkLabel', { title: task.title, done: t('done') })}
        tabindex="-1"
        bind:this={mark}
      >
        <Icon name="check" /><b>{t('doneStamp')}</b>
      </span>
    {:else if canComplete}
      <button
        class="done-btn"
        type="button"
        aria-label={t('taskCompleteLabel', { complete: t('complete'), title: task.title })}
        title={t('complete')}
        aria-disabled={pending}
        onclick={() => {
          if (!pending) onComplete(task);
        }}
      >
        <Icon name="check" />
      </button>
    {/if}
  </div>
</div>
