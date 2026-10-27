<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { BacklogEpic } from '../../shared/operations/task/backlog-tree.ts';
  import type { DropRow } from '../backlog-drop.ts';
  import type { BacklogDnd } from '../backlog-dnd.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import DefinitionChip from './DefinitionChip.svelte';
  import DueChip from './DueChip.svelte';
  import Icon from './Icon.svelte';

  // kit.js の treeEpic（バックログの木のエピックの行と、配下）。行の組み方は TreeStory と同じで、開閉は左端の caret のボタンだけが受け持ち、
  // 題を押すとエピックのダイアログ（onEdit）を開く。開閉の状態は部品の中に持ち、expand() で開ける（ストーリーを移してきたときに開く）。
  // 右端は配下のポイントの「完了 / 全体」（pointsDone と pointsAll は、画面が足した行と完了にした行の分を含む合計）。
  // 完了（クリア）か中止したエピックには、その状態の印を添え、期日には色を付けない。
  // 配下のストーリーの行は children の snippet で描く（ストーリーの操作は画面の側が持つ）。empty が真なら「<ストーリー>はまだありません」を出す。
  // クリア、中止、依頼主と討伐隊は、エピックの画面の Issue（#65）で足す。
  // onMove を渡すと（書き込めて、絞っていないとき）、行の右端に「上へ」「下へ」を出し、エピックの行の中で Alt と ↑ ↓ を押しても同じことをする
  // （TreeStory と同じ。キーは配下のストーリーとタスクの行には掛けない。端の向きは aria-disabled）。完了と中止したエピックも並べ替えられる。
  // onMove と dnd を渡すと、行の先頭にドラッグのつまみ（.grip。飾りで aria-hidden）を置く。つかむのはここだけ。
  // dnd を渡すと、行は、ストーリーを運ぶときの落とし先（囲み。離すと配下の末尾に入り、畳まれていれば開く）と、エピックを運ぶときの
  // 前後の線の落とし先を兼ねる。前後の線は、開いた配下の途中に入らないよう、配下を含めた塊（.tree-group）に引く（エピックの段の字下げ）。
  // 空の案内の行の前後も、配下の末尾の落とし先
  let {
    epic,
    pointsDone,
    pointsAll,
    clock,
    onEdit,
    empty,
    canMoveUp = false,
    canMoveDown = false,
    onMove,
    dnd,
    children,
  }: {
    epic: BacklogEpic;
    pointsDone: number;
    pointsAll: number;
    clock: { today: string; weekStart: number };
    onEdit: (epic: BacklogEpic, trigger: HTMLElement) => void;
    empty: boolean;
    canMoveUp?: boolean;
    canMoveDown?: boolean;
    onMove?: (epic: BacklogEpic, delta: -1 | 1) => void;
    dnd?: BacklogDnd;
    children: Snippet;
  } = $props();

  const dropRow = $derived<DropRow>({ kind: 'epic', id: epic.id });
  const tailRow = $derived<DropRow>({ kind: 'tail', parent: 'epic', id: epic.id });
  const hasGrip = $derived(onMove !== undefined && dnd !== undefined);
  const dropMark = $derived(dnd?.markOf(dropRow));

  function move(delta: -1 | 1): void {
    if (delta < 0 ? !canMoveUp : !canMoveDown) return;
    onMove?.(epic, delta);
  }

  function keydown(event: KeyboardEvent): void {
    if (onMove === undefined || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    // 端でも画面に渡す（画面が、動かせないことを読み上げる）
    onMove(epic, event.key === 'ArrowUp' ? -1 : 1);
  }

  const bodyId = $props.id();
  let expanded = $state(true);
  const finished = $derived(epic.completed_at !== null || epic.canceled_at !== null);

  export function expand(): void {
    expanded = true;
  }
</script>

<div
  class="tree-group"
  class:is-dragging={dnd?.isDragging('epic', epic.id)}
  data-drop={dropMark === 'into' ? undefined : dropMark}
>
  <!-- キーは中のボタンから届く。行そのものはフォーカスを受けない -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="tree-row is-epic"
    class:has-grip={hasGrip}
    class:is-dropped={dnd?.isFlashing('epic', epic.id)}
    onkeydown={keydown}
    data-row-id={epic.id}
    data-drop={dropMark === 'into' ? 'into' : undefined}
    {@attach dnd?.target(dropRow)}
  >
    {#if hasGrip}
      <span class="grip" aria-hidden="true" {@attach dnd?.handle({ kind: 'epic', id: epic.id })}
        ><Icon name="grip" /></span
      >
    {/if}
    <button
      class="tree-caret"
      type="button"
      aria-expanded={expanded}
      aria-controls={bodyId}
      aria-label={expanded ? t('treeClose', { title: epic.title }) : t('treeOpen', { title: epic.title })}
      onclick={() => (expanded = !expanded)}
    >
      <Icon name="chevron" />
    </button>
    <span class="kind is-epic" title={t('epic')}><Icon name="flag" /></span>
    <span class="tree-title">
      <button class="tree-link" type="button" onclick={(event) => onEdit(epic, event.currentTarget)}
        >{epic.title}</button
      >
      <!-- 区分はエピックに振ったものを出す（配下のストーリーとタスクは引き継ぐので、繰り返さない） -->
      {#if epic.category !== null}
        <DefinitionChip kind="category" name={epic.category.name} />
      {/if}
      {#if epic.completed_at !== null}
        <span class="chip is-done"><Icon name="check" />{t('epicCleared')}</span>
      {:else if epic.canceled_at !== null}
        <span class="chip">{t('epicCanceled')}</span>
      {/if}
      {#if epic.due_on !== null}
        <DueChip dueOn={epic.due_on} today={clock.today} weekStart={clock.weekStart} done={finished} />
      {/if}
    </span>
    <span class="tree-end">
      <span class="tree-ratio" title={t('treeRatioTitle', { done: t('done') })}
        >{t('treeRatio', { done: t('done'), value: pointsDone, all: pointsAll })}</span
      >
      {#if onMove !== undefined}
        <span class="order-actions">
          <button
            class="icon-btn"
            type="button"
            aria-label={t('moveUpLabel', { title: epic.title })}
            title={t('moveUp')}
            aria-disabled={!canMoveUp}
            onclick={() => move(-1)}><Icon name="up" /></button
          >
          <button
            class="icon-btn"
            type="button"
            aria-label={t('moveDownLabel', { title: epic.title })}
            title={t('moveDown')}
            aria-disabled={!canMoveDown}
            onclick={() => move(1)}><Icon name="down" /></button
          >
        </span>
      {/if}
    </span>
  </div>
  <div class="tree-children" id={bodyId} hidden={!expanded}>
    {@render children()}
    {#if empty}
      <p class="tree-folded" data-drop={dnd?.markOf(tailRow)} {@attach dnd?.target(tailRow)}>
        {t('epicNoStories', { story: t('story') })}
      </p>
    {/if}
  </div>
</div>
