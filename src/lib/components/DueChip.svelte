<script lang="ts">
  import { dueStatus } from '../../shared/due.ts';
  import { formatMonthDay } from '../format.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // kit.js の dueChip。期日の印。今日の日付と週の始まりは、API が返したワークスペースの値を渡す（ブラウザの時計に頼らない）。
  // 過ぎた期日は赤で警告のアイコンと「期日切れ」、今日と今週は橙で時計のアイコン、それ以外は色なし。
  // 色だけに頼らず、必ずアイコンと文字を添える。完了したタスクは色を付けない（done）
  let {
    dueOn,
    today,
    weekStart,
    done = false,
  }: { dueOn: string; today: string; weekStart: number; done?: boolean } = $props();

  const status = $derived(done ? 'later' : dueStatus(dueOn, today, weekStart));
  const date = $derived(formatMonthDay(dueOn));
</script>

{#if status === 'overdue'}
  <span class="chip is-danger"><Icon name="alert" />{t('dueOverdue', { due: t('due'), date })}</span>
{:else if status === 'today'}
  <span class="chip is-warn"><Icon name="clock" />{t('dueToday')}</span>
{:else if status === 'this_week'}
  <span class="chip is-warn"><Icon name="clock" />{t('dueThisWeek', { date })}</span>
{:else}
  <span class="chip"><Icon name="clock" />{date}</span>
{/if}
