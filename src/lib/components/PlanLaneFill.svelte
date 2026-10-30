<script lang="ts">
  import { formatPoints, isOverVelocity, laneFillShape, overBy } from '../plan-summary.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // design/plan.html の lane-fill。先のスプリントに入れたポイントの棒と、ベロシティの印。
  // 入れたポイントがベロシティを上回るときは、棒を赤（is-over）にするだけでなく、警告のアイコンと文字
  // （超過・ベロシティより N pt 多い）の印でも示す（色だけで伝えない）。
  // ベロシティが出ていない（average が null）ときは比べる相手が無いので、棒を出さず、入れたポイントの文字だけを出す。
  // 棒の幅と印の位置は style:（CSSOM）で渡す。style 属性の文字列は CSP の style-src に止められる
  let { points, average }: { points: number; average: number | null } = $props();

  const shape = $derived(laneFillShape(points, average));
  const over = $derived(isOverVelocity(points, average));
  const velocityWord = $derived(t('velocity'));
</script>

<div class="lane-fill" data-lane-fill>
  {#if average !== null && shape.mark !== null}
    <div
      class="lane-fill-bar"
      class:is-over={over}
      role="img"
      aria-label={t('planFilledLabel', { points, velocity: velocityWord, value: formatPoints(average) })}
    >
      <span style:width={`${shape.width}%`}></span><i style:left={`${shape.mark}%`}></i>
    </div>
  {/if}
  <div class="lane-fill-text">
    <span>{t('planFilled', { points })}</span>
    {#if over && average !== null}
      <span class="chip is-danger" data-lane-over
        ><Icon name="alert" />{t('planFilledOver', {
          over: t('over'),
          velocity: velocityWord,
          gap: formatPoints(overBy(points, average)),
        })}</span
      >
    {/if}
    {#if average !== null}
      <span>{t('planFilledVelocity', { velocity: velocityWord, value: formatPoints(average) })}</span>
    {/if}
  </div>
</div>
