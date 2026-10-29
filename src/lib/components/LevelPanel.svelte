<script lang="ts">
  import { levelProgressOf } from '../../shared/experience.ts';
  import { formatCount } from '../format.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Emblem from './Emblem.svelte';
  import Icon from './Icon.svelte';

  // kit.js の levelPanel。自分の記録の面で、本人にだけ出す（経験値の数値を含む）。
  // 紋章（大）、合計、次のレベルまでの残りと見込み、10の目盛りのゲージ（確定は塗り、見込みは斜線）、凡例、
  // ワークスペースごとの内訳と「すべての<ワークスペース>」の合計。レベルとゲージの割合は src/shared/experience.ts の式で出す。
  // ゲージの幅は style:width（CSSOM）で渡す（style 属性の文字列は CSP に止められる）
  let {
    total,
    prospective,
    workspaces = null,
  }: {
    total: number;
    prospective: number;
    workspaces?: { id: string; name: string; total: number }[] | null;
  } = $props();

  const titleId = $props.id();
  let title = $state<HTMLElement>();

  // 読み直した後に、面の題へフォーカスを移す（自分の設定の画面の「もう一度試す」）
  export function focusTitle(): void {
    title?.focus();
  }
  const progress = $derived(levelProgressOf(total, prospective));
  const confirmedPercent = $derived(Math.round(progress.confirmedRatio * 100));
  const prospectivePercent = $derived(Math.round(progress.prospectiveRatio * 100));
</script>

<section class="panel" aria-labelledby={titleId}>
  <!-- 題は見出し（h2）。tabindex="-1" は、読み直した後にプログラムからフォーカスを置くため（focusTitle） -->
  <div class="panel-title">
    <h2 id={titleId} tabindex="-1" bind:this={title}>{t('levelPanelTitle')}</h2>
    {t('levelPanelNote')}
  </div>
  <div class="level">
    <Emblem level={progress.level} />
    <div>
      <div class="xp-num"><Icon name="crystal" tone="xp" />{formatCount(total)}<small>{t('xpUnit')}</small></div>
      <div class="xp-sub">
        {t('levelToNext')} <b>{formatCount(progress.toNext)}</b>{t('levelSubSeparator')}{t('levelProspect')}
        <b>{t('xpPlus', { value: formatCount(prospective) })}</b>
      </div>
    </div>
  </div>
  <div
    class="gauge"
    role="img"
    aria-label={t('levelGaugeLabel', { confirmed: confirmedPercent, prospective: prospectivePercent })}
  >
    <span class="gauge-got" style:width={`${progress.confirmedRatio * 100}%`}></span>
    <span class="gauge-soon" style:width={`${progress.prospectiveRatio * 100}%`}></span>
  </div>
  <div class="legend">
    <span><i class="is-got"></i>{t('levelLegendConfirmed')}</span>
    <span><i class="is-soon"></i>{t('levelLegendProspect', { task: t('task'), done: t('done') })}</span>
  </div>
  {#if workspaces !== null && workspaces.length > 0}
    <!-- dl は役割を持たないので、名前は包む group に付ける -->
    <div role="group" aria-label={t('levelBreakdownLabel', { workspace: t('workspace') })}>
      <dl class="breakdown">
        {#each workspaces as workspace (workspace.id)}
          <div>
            <dt>{workspace.name}</dt>
            <dd>{formatCount(workspace.total)}</dd>
          </div>
        {/each}
        <div class="is-total">
          <dt>{t('levelBreakdownTotal', { workspace: t('workspace') })}</dt>
          <dd>{formatCount(total)}</dd>
        </div>
      </dl>
    </div>
  {/if}
</section>
