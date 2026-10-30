<script lang="ts">
  import type { PlanVelocity } from '../../shared/operations/sprint/index.ts';
  import { formatPoints, velocityBarShape } from '../plan-summary.ts';
  import { sprintShortName } from '../sprint-label.ts';
  import { t } from '../vocabulary.svelte.ts';

  // design/plan.html の velocity。延長していない終了したスプリントの新しい 3 つの完了ポイントの平均と、各回の棒。
  // 延長した回（counted が偽）は棒を斜線にして平均から除き、棒の下に「延長 N 日・除外」を文字でも添える。
  // 終了したスプリントが無ければ、平均の代わりに「まだ出ません」の文を出す。
  // 棒の高さと平均の線は style:（CSSOM）で渡す。style 属性の文字列は CSP の style-src に止められる
  let { velocity }: { velocity: PlanVelocity } = $props();

  const CHART_HEIGHT = 90;

  const words = $derived({ velocity: t('velocity'), sprint: t('sprint') });
  const countedCount = $derived(velocity.sprints.filter((item) => item.counted).length);
  const shape = $derived(
    velocityBarShape(
      velocity.sprints.map((item) => item.points),
      velocity.average,
      CHART_HEIGHT,
    ),
  );
  const chartLabel = $derived(
    velocity.sprints
      .map(
        (item) =>
          t('velocityBarItem', { label: sprintShortName(item, t), points: item.points }) +
          (item.counted ? '' : t('velocityBarExcluded')),
      )
      .join('、'),
  );
</script>

<section class="panel" aria-label={t('velocity')}>
  {#if velocity.sprints.length === 0}
    <p class="action-note" data-velocity-empty>{t('velocityEmpty', words)}</p>
  {:else}
    <!-- 平均が出ない理由の文は、平均の列（.stat の auto 列）に入れず、グリッドの上に置く（長い文が棒を潰さない） -->
    {#if velocity.average === null}
      <p class="action-note" data-velocity-empty>{t('velocityAllExtended', words)}</p>
    {/if}
    <div class="velocity">
      <div class="stat">
        {#if velocity.average !== null}
          <span class="stat-label">{t('velocityAverage', { velocity: t('velocity'), count: countedCount })}</span>
          <span class="stat-num" data-velocity-average>{formatPoints(velocity.average)}<small>pt</small></span>
        {/if}
        <span class="stat-label">{t('velocityExcludedNote', words)}</span>
      </div>
      <div>
        <div class="bars" role="img" aria-label={chartLabel}>
          {#if velocity.average !== null && shape.mark !== null}
            <span class="bars-avg" style:bottom={`${shape.mark}px`}
              ><span>{t('velocityAverageMark', { value: formatPoints(velocity.average) })}</span></span
            >
          {/if}
          {#each velocity.sprints as item, index (item.id)}
            <div class="bar-col" class:is-excluded={!item.counted} data-velocity-sprint={item.id}>
              <b>{item.points}</b><i style:height={`${shape.heights[index]}px`}></i>
            </div>
          {/each}
        </div>
        <div class="bars-labels">
          {#each velocity.sprints as item (item.id)}
            <span
              >{sprintShortName(item, t)}{#if !item.counted}<br />{t('velocityExcludedLabel', {
                  days: item.extended_days,
                })}{/if}</span
            >
          {/each}
        </div>
      </div>
    </div>
  {/if}
</section>
