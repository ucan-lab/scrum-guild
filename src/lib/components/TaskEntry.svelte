<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { BacklogTask } from '../../shared/operations/task/backlog-tree.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Avatar from './Avatar.svelte';
  import DueChip from './DueChip.svelte';
  import Icon from './Icon.svelte';

  // kit.js の entry（台帳の1行）と doneControl。今あるのは、タイトル（`?task=<ID>` へのリンク）、期日の印、ポイント、担当、
  // 完了の操作と完了の印。リンクの開く先（詳細の引き出し）は、タスクの詳細の Issue で足す。
  // 先頭の「今日やる」、親は、それぞれの機能の Issue で足す。先頭の枠（.entry の1列目）は、その機能が入るまで空の要素で埋める。
  // 期日の印は、API が返したワークスペースの今日の日付と週の始まり（clock）で決める。完了にした行は色を付けない。
  // 完了の操作が押されると、onComplete を呼ぶ。完了にした行は、done を真にして完了の印を付ける。
  // 押したボタンは消えるので、完了の印にフォーカスを移せるよう focusMark() を出す。
  // canComplete が偽（閉じたワークスペース）の行は、完了の操作を出さない。pending の間は押しても無視する（aria-disabled）
  let {
    task,
    clock,
    done = false,
    pending = false,
    canComplete = true,
    onComplete,
  }: {
    task: BacklogTask;
    clock: { today: string; weekStart: number };
    done?: boolean;
    pending?: boolean;
    canComplete?: boolean;
    onComplete: (task: BacklogTask) => void;
  } = $props();

  let mark = $state<HTMLElement>();
  // タイトルのリンクは、今のワークスペースの画面に `?task=<ID>` を付ける
  const taskHref = $derived(resolve('/[slug]/w/[id]', { slug: page.params.slug ?? '', id: page.params.id ?? '' }));

  export function focusMark(): void {
    mark?.focus();
  }
</script>

<div class="entry" class:is-done={done}>
  <span aria-hidden="true"></span>
  <div class="entry-main">
    <!-- 開く先（詳細の引き出し）はまだ無い。押しても、フォーカスとスクロールの位置は動かさない -->
    <a
      class="entry-title"
      href="{taskHref}?task={encodeURIComponent(task.id)}"
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
