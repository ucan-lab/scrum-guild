<script lang="ts">
  import type { SprintSummary } from '../../shared/operations/sprint/index.ts';
  import { formatMonthDay } from '../format.ts';
  import { sprintLabel } from '../sprint-label.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // 最終日を過ぎた進行中のスプリントの知らせ（スプリントの画面と計画の画面）。終えるよう促す警告の囲み（.callout.is-warn）。
  // 終えられる人（終了していないワークスペースのリーダーと管理者）には「終える」を添え、終了のダイアログを開く。
  // 出すかどうかの判定（進行中で、ワークスペースの今日が最終日より後）は呼ぶ側が行う
  let {
    sprint,
    canClose,
    onclose,
  }: {
    sprint: Pick<SprintSummary, 'name' | 'start_on' | 'end_on'>;
    canClose: boolean;
    onclose: (trigger: HTMLElement) => void;
  } = $props();

  const label = $derived(sprintLabel(sprint, t));
  const end = $derived(formatMonthDay(sprint.end_on));
</script>

<div class="callout is-warn">
  <Icon name="alert" />
  <span>
    {canClose
      ? t('sprintOverdueLeader', { label, end, task: t('task') })
      : t('sprintOverdueMember', { label, end, leader: t('leader') })}
  </span>
  {#if canClose}
    <div class="callout-actions">
      <button
        class="btn is-sm"
        type="button"
        aria-label={t('sprintCloseLabel', { label })}
        onclick={(event) => onclose(event.currentTarget)}>{t('sprintCloseAction')}</button
      >
    </div>
  {/if}
</div>
