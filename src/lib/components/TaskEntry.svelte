<script lang="ts">
  import type { TaskListItem } from '../../shared/operations/task/task-list.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';

  // kit.js の entry（台帳の1行）と doneControl。今あるのは、タイトル、ポイント、担当、完了の操作と完了の印。
  // 先頭の「今日やる」、親、期日、タイトルのリンク（詳細の引き出し）は、それぞれの機能の Issue で足す。
  // 先頭の枠（.entry の1列目）は、その機能が入るまで空の要素で埋める。
  // 完了の操作が押されると、onComplete を呼ぶ。完了にした行は、done を真にして完了の印を付ける。
  // 押したボタンは消えるので、完了の印にフォーカスを移せるよう focusMark() を出す。
  // canComplete が偽（閉じたワークスペース）の行は、完了の操作を出さない。pending の間は押しても無視する（aria-disabled）
  let {
    task,
    done = false,
    pending = false,
    canComplete = true,
    onComplete,
  }: {
    task: TaskListItem;
    done?: boolean;
    pending?: boolean;
    canComplete?: boolean;
    onComplete: (task: TaskListItem) => void;
  } = $props();

  let mark = $state<HTMLElement>();

  export function focusMark(): void {
    mark?.focus();
  }
</script>

<div class="entry" class:is-done={done}>
  <span aria-hidden="true"></span>
  <div class="entry-main">
    <span class="entry-title">{task.title}</span>
  </div>
  <div class="entry-end">
    {#if task.points === null}
      <span class="pts is-none" title={t('pointsUnsetTitle')}>{t('pointsUnsetMark')}</span>
    {:else}
      <span class="pts" title="{t('points')} {task.points}">{task.points}</span>
    {/if}
    {#if task.assignee === null}
      <Avatar userId={null} />
    {:else}
      <Avatar userId={task.assignee.id} name={task.assignee.name} />
    {/if}
    {#if done}
      <!-- tabindex="-1" は、完了にした後にフォーカスを置くため（キーボードの Tab 順には入らない） -->
      <span class="hanko is-new" role="img" aria-label={t('done')} tabindex="-1" bind:this={mark}>
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
