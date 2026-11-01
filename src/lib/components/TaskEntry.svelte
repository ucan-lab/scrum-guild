<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { BacklogTask } from '../../shared/operations/task/backlog-tree.ts';
  import type { DropRow } from '../backlog-drop.ts';
  import type { BacklogDnd } from '../backlog-dnd.svelte.ts';
  import { taskDetailHref, taskLinkAttrs } from '../drawer.svelte.ts';
  import { sprintShortName } from '../sprint-label.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Avatar from './Avatar.svelte';
  import DefinitionChip from './DefinitionChip.svelte';
  import DueChip from './DueChip.svelte';
  import Icon from './Icon.svelte';

  // kit.js の entry（台帳の1行）と doneControl。今あるのは、タイトル（`?task=<ID>` へのリンク）、期日の印、ポイント、担当、
  // 完了の操作と完了の印。リンクは詳細の引き出しを開く（/[slug]/w/[id] のレイアウトが `?task=<ID>` を見て置く）。
  // 先頭の「今日やる」、親は、それぞれの機能の Issue で足す。先頭の枠（.entry の1列目）は、その機能が入るまで空の要素で埋める。
  // 期日の印は、API が返したワークスペースの今日の日付と週の始まり（clock）で決める。完了にした行は色を付けない。
  // 完了の操作が押されると、onComplete を呼ぶ（canComplete が偽で操作を出さない行は渡さなくてよい）。完了にした行は、done を真にして完了の印を付ける。
  // 複数のワークスペースの行を並べる画面（今日やること）は、行ごとに workspaceId（タイトルのリンク先）と workspaceName（.entry-meta の先頭に
  // .tag で出す）を渡す。metaChip は期日の印とは別に添える橙の印（今週が期日の行の「期日は今日」）、metaText は注記（.props-note。持ち越しの日数）
  // 押したボタンは消えるので、完了の印にフォーカスを移せるよう focusMark() を出す。
  // canComplete が偽（閉じたワークスペース）の行は、完了の操作を出さない。pending の間は押しても無視する（aria-disabled）
  // onMove を渡すと、「上へ」「下へ」（同じ親の中で1つ動かす）を出し、行の中で Alt と ↑ ↓ を押しても同じことをする。
  // 端で動かせない向き（canMoveUp、canMoveDown が偽）は、フォーカスを失わないよう disabled でなく aria-disabled にする。
  // onMoveParent を渡すと「親を移す」も出す。完了にした行には出さない。絞り込み中は、画面が onMove を渡さず（並べ替えは隣を使うため）、
  // 「親を移す」だけを出す。
  // タイトルの下（.entry-meta）に、入っているスプリント（kit.js の sprintTag。暦のアイコンと名前、名前が無ければ期間）、
  // 振ったリポジトリ（kit.js の repoTag。git のアイコン）と、showCategory のとき（親のないタスク）だけ区分を出す。
  // 親のあるタスクの区分は親の行に出ているので、繰り返さない。
  // onMove と dnd を渡すと（書き込めるとき）、行の先頭にドラッグのつまみ（.grip。飾りで aria-hidden）を置く。つかむのはここだけで、
  // 完了にした行はつかめない（列だけ空ける）。ほかの行をつかんだときの落とす位置は、行の data-drop（線）で示す。狭い幅と指の画面では CSS がつまみを隠す。
  // ドラッグの代わりは「上へ」「下へ」と Alt と ↑ ↓
  // 完了の印の判を押す動き（.is-new）は、今押した行（justDone が真）だけで再生する。開いた時点で完了済みの行（今日やることの今日完了）は静止した印を出す
  let {
    task,
    clock,
    done = false,
    justDone = false,
    pending = false,
    canComplete = true,
    onComplete,
    canMoveUp = false,
    canMoveDown = false,
    onMove,
    onMoveParent,
    showCategory = false,
    dnd,
    taskQuery = '?task=',
    workspaceId,
    workspaceName,
    metaChip,
    metaText,
  }: {
    task: BacklogTask;
    clock: { today: string; weekStart: number };
    done?: boolean;
    justDone?: boolean;
    pending?: boolean;
    canComplete?: boolean;
    onComplete?: (task: BacklogTask) => void;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
    onMove?: (task: BacklogTask, delta: -1 | 1) => void;
    onMoveParent?: (task: BacklogTask, trigger: HTMLElement) => void;
    showCategory?: boolean;
    dnd?: BacklogDnd;
    taskQuery?: string;
    workspaceId?: string;
    workspaceName?: string;
    metaChip?: string;
    metaText?: string;
  } = $props();

  const category = $derived(showCategory ? task.category : null);

  const movable = $derived(onMove !== undefined && !done);
  const dropRow = $derived<DropRow>({ kind: 'task', id: task.id });
  const hasGrip = $derived(onMove !== undefined && dnd !== undefined);
  const parentMovable = $derived(onMoveParent !== undefined && !done);

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
  // タイトルのリンクは、今のワークスペースの画面に `?task=<ID>` を付ける。絞り込みの問い合わせ（assignee、q など）は残す。
  // 問い合わせの前半（taskQuery。`?...&task=` か `?task=`）は画面が1回だけ組んで渡し、行は ID だけを足す
  const taskHref = $derived(
    resolve('/[slug]/w/[id]', { slug: page.params.slug ?? '', id: workspaceId ?? page.params.id ?? '' }),
  );

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
<div
  class="entry"
  class:is-done={done}
  class:has-grip={hasGrip}
  class:is-dragging={dnd?.isDragging('task', task.id)}
  class:is-dropped={dnd?.isFlashing('task', task.id)}
  onkeydown={keydown}
  data-row-id={task.id}
  data-drop={dnd?.markOf(dropRow)}
  {@attach dnd?.target(dropRow)}
>
  {#if hasGrip}
    {#if movable}
      <span class="grip" aria-hidden="true" {@attach dnd?.handle({ kind: 'task', id: task.id })}
        ><Icon name="grip" /></span
      >
    {:else}
      <span class="grip is-off" aria-hidden="true"></span>
    {/if}
  {/if}
  <span aria-hidden="true"></span>
  <div class="entry-main">
    <!-- 横と真ん中のときは、押しても、フォーカスとスクロールの位置は動かさない（引き出しが閉じたとき、data-task-id で探してフォーカスを戻す）。ページ全体の既定では taskLinkAttrs が reset を外し、先頭から表示する -->
    <!-- eslint-disable svelte/no-navigation-without-resolve -- href は resolve した経路に ?task=<ID> を足したもの、またはその詳細ページ -->
    <a
      class="entry-title"
      href={taskDetailHref(`${taskHref}${taskQuery}${encodeURIComponent(task.id)}`)}
      data-task-id={task.id}
      {...taskLinkAttrs()}>{task.title}</a
    >
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
    {#if workspaceName !== undefined || task.repository !== null || category !== null || task.sprint !== null || metaChip !== undefined || metaText !== undefined}
      <span class="entry-meta">
        {#if workspaceName !== undefined}<span class="tag">{workspaceName}</span>{/if}
        {#if task.sprint !== null}
          <DefinitionChip kind="sprint" name={sprintShortName(task.sprint, t)} mono={task.sprint.name === null} />
        {/if}
        {#if task.repository !== null}
          <DefinitionChip kind="repository" name={task.repository.name} />
        {/if}
        {#if category !== null}
          <DefinitionChip kind="category" name={category.name} />
        {/if}
        {#if metaChip !== undefined}<span class="chip is-warn">{metaChip}</span>{/if}
        {#if metaText !== undefined}<span class="props-note">{metaText}</span>{/if}
      </span>
    {/if}
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
    {#if movable || parentMovable}
      <span class="order-actions">
        {#if movable}
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
        {/if}
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
        class="hanko"
        class:is-new={justDone}
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
          if (!pending) onComplete?.(task);
        }}
      >
        <Icon name="check" />
      </button>
    {/if}
  </div>
</div>
