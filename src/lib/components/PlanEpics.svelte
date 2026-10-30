<script lang="ts">
  import { resolve } from '$app/paths';
  import type { PlanEpic } from '../../shared/operations/sprint/index.ts';
  import { epicRemaining } from '../plan-summary.ts';
  import { t } from '../vocabulary.svelte.ts';
  import DueChip from './DueChip.svelte';
  import Progress from './Progress.svelte';
  import Section from './Section.svelte';

  // design/plan.html の「エピックごとの残り」の表。削除していない、完了も中止もしていないエピックを、題（エピックの画面への
  // リンク）、残りのポイント（配下の未完了のタスクのポイントの合計）、進み（完了 / 全体）、期日の印で並べる。
  // 今日の日付と週の始まりは API が返したワークスペースの値（ブラウザの時計に頼らない）。
  // 狭い幅では行を縦に積み（is-stacked）、td の data-label を値の前に出す
  let {
    epics,
    slug,
    workspaceId,
    today,
    weekStart,
  }: { epics: PlanEpic[]; slug: string; workspaceId: string; today: string; weekStart: number } = $props();
</script>

<Section id="plan-epics" title={t('planEpicsTitle', { epic: t('epic') })}>
  {#if epics.length === 0}
    <p class="action-note" data-plan-epics-empty>{t('planEpicsEmpty', { epic: t('epic') })}</p>
  {:else}
    <div class="table-wrap">
      <table class="table is-stacked">
        <thead>
          <tr>
            <th class="is-name">{t('epic')}</th>
            <th class="is-num">{t('planEpicRemaining')}</th>
            <th>{t('planEpicProgress')}</th>
            <th>{t('due')}</th>
          </tr>
        </thead>
        <tbody>
          {#each epics as epic (epic.id)}
            <tr data-plan-epic={epic.id}>
              <td class="is-name">
                <a href={resolve('/[slug]/w/[id]/epics/[epicId]', { slug, id: workspaceId, epicId: epic.id })}
                  >{epic.title}</a
                >
              </td>
              <td class="is-num" data-label={t('planEpicRemaining')}>{epicRemaining(epic)}</td>
              <td data-label={t('planEpicProgress')}><Progress done={epic.points_done} all={epic.points_all} /></td>
              <td data-label={epic.due_on === null ? undefined : t('due')}>
                {#if epic.due_on !== null}<DueChip dueOn={epic.due_on} {today} {weekStart} />{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</Section>
