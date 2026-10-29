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
  // 端のボタンは aria-disabled（フォーカスを失わない）で、押したり、端で Alt と矢印を押したりしても画面に渡し、動かせないことを読み上げさせる。
  // 最後の完了でない列の「次の列へ」と Alt と → は、画面が完了にする（task-complete）。
  // 完了したカードは、完了の印の横に「戻す」（kit.js の doneControl の .link-btn。task-reopen）を、戻せるとき（canReopen）だけ出す
  let {
    task,
    href,
    edges,
    canComplete,
    canReopen = false,
    clock,
    pending = false,
    hintId,
    onmove,
    oncomplete,
    onreopen,
  }: {
    task: SprintBoardTask;
    href: string;
    // 動かし方の案内（画面の下の .action-note）の id。選んだカードの説明に結ぶ
    hintId?: string;
    // 期日の印を決める今日（ワークスペースのタイムゾーン）と週の始まり。API の値を渡す
    clock: { today: string; weekStart: number };
    // 動かせないカード（完了の列、書き込めない）は null
    // completes は、次の列が完了の列で「次の列へ」が完了にすること（読み上げの名前と title を完了の操作の名前にする）
    edges: { top: boolean; bottom: boolean; prev: boolean; next: boolean; completes: boolean } | null;
    canComplete: boolean;
    // 完了したカードの「戻す」を出すか（書き込めて、task.reopenable が真）
    canReopen?: boolean;
    pending?: boolean;
    onmove: (task: SprintBoardTask, direction: MoveDirection) => void;
    oncomplete: (task: SprintBoardTask) => void;
    onreopen?: (task: SprintBoardTask) => void;
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
    // 押しっぱなしの自動の繰り返しでは、完了の列の手前から完了にしない（列を送るうちに気づかず完了にしないため）
    if (event.repeat && direction === 'right' && edges?.completes === true) return;
    onmove(task, direction);
  }

  const column = $derived(t('column'));
  const titleId = $derived(`card-${task.id}-title`);
  const summaryId = $derived(`card-${task.id}-summary`);
  const pointsText = $derived(
    task.points === null ? t('pointsUnsetTitle') : t('pointsLabel', { points: t('points'), value: task.points }),
  );
  const summary = $derived(
    task.assignee === null
      ? t('sprintCardSummaryUnassigned', { points: pointsText, unassigned: t('unassigned') })
      : t('sprintCardSummary', { points: pointsText, assignee: t('assignee'), name: task.assignee.name }),
  );
</script>

<!-- キーは中のリンクとボタンから届く。選べるのは動かせるカードだけ（tabindex は 0 か未指定だけ） -->
<!-- 選んだときは題を名前に、ポイントと担当の要約と動かし方の案内を説明に読む（中の印は role="img" で、選んだだけでは読まれないため） -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<article
  class="card"
  class:is-done={done}
  tabindex={movable ? 0 : undefined}
  aria-labelledby={movable ? titleId : undefined}
  aria-describedby={movable ? [summaryId, hintId].filter(Boolean).join(' ') : undefined}
  data-card-id={task.id}
  onkeydown={keydown}
>
  {#if movable}<span class="visually-hidden" id={summaryId}>{summary}</span>{/if}
  {#if task.story !== null}
    <span class="card-parent"><Icon name="flag" /> {task.story.title}</span>
  {/if}
  <!-- 押しても、フォーカスとスクロールの位置は動かさない（引き出しが閉じたとき、data-task-id で探してフォーカスを戻す） -->
  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- href は画面が resolve した経路に ?task=<ID> を足したもの -->
  <a class="card-title" id={titleId} {href} data-task-id={task.id} data-sveltekit-reset="false">{task.title}</a>
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
        {#if canReopen}
          <button
            class="link-btn"
            type="button"
            aria-label={t('taskReopenLabel', { done: t('done'), title: task.title })}
            aria-disabled={pending}
            onclick={() => {
              if (!pending) onreopen?.(task);
            }}>{t('taskReopen')}</button
          >
        {/if}
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
          aria-label={edges.completes
            ? t('moveColumnCompleteLabel', { done: t('done'), column, complete: t('complete'), title: task.title })
            : t('moveColumnNextLabel', { column, title: task.title })}
          title={edges.completes
            ? t('moveColumnComplete', { done: t('done'), column, complete: t('complete') })
            : t('moveColumnNext', { column })}
          aria-disabled={edges.next}
          onclick={() => onmove(task, 'right')}><Icon name="right" /></button
        >
      </span>
    </div>
  {/if}
</article>
