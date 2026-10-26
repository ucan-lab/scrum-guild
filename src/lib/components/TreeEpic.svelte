<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { BacklogEpic } from '../../shared/operations/task/backlog-tree.ts';
  import { t } from '../vocabulary.svelte.ts';
  import DueChip from './DueChip.svelte';
  import Icon from './Icon.svelte';

  // kit.js の treeEpic（バックログの木のエピックの行と、配下）。行の組み方は TreeStory と同じで、開閉は左端の caret のボタンだけが受け持ち、
  // 題を押すとエピックのダイアログ（onEdit）を開く。開閉の状態は部品の中に持ち、expand() で開ける（ストーリーを移してきたときに開く）。
  // 右端は配下のポイントの「完了 / 全体」（pointsDone と pointsAll は、画面が足した行と完了にした行の分を含む合計）。
  // 完了（クリア）か中止したエピックには、その状態の印を添え、期日には色を付けない。
  // 配下のストーリーの行は children の snippet で描く（ストーリーの操作は画面の側が持つ）。empty が真なら「<ストーリー>はまだありません」を出す。
  // 並べ替え、クリア、中止、依頼主と討伐隊は、エピックの画面の Issue（#65）で足す
  let {
    epic,
    pointsDone,
    pointsAll,
    clock,
    onEdit,
    empty,
    children,
  }: {
    epic: BacklogEpic;
    pointsDone: number;
    pointsAll: number;
    clock: { today: string; weekStart: number };
    onEdit: (epic: BacklogEpic, trigger: HTMLElement) => void;
    empty: boolean;
    children: Snippet;
  } = $props();

  const bodyId = $props.id();
  let expanded = $state(true);
  const finished = $derived(epic.completed_at !== null || epic.canceled_at !== null);

  export function expand(): void {
    expanded = true;
  }
</script>

<div class="tree-group">
  <div class="tree-row is-epic" data-row-id={epic.id}>
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
      {#if epic.completed_at !== null}
        <span class="chip is-ok"><Icon name="check" />{t('epicCleared')}</span>
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
    </span>
  </div>
  <div class="tree-children" id={bodyId} hidden={!expanded}>
    {@render children()}
    {#if empty}
      <p class="tree-folded">{t('epicNoStories', { story: t('story') })}</p>
    {/if}
  </div>
</div>
