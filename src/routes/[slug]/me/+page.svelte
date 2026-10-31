<script lang="ts">
  import { tick } from 'svelte';
  import { page } from '$app/state';
  import { callOperation } from '../../../lib/api.ts';
  import ApiTokensSetting from '../../../lib/components/ApiTokensSetting.svelte';
  import EmptyState from '../../../lib/components/EmptyState.svelte';
  import Icon from '../../../lib/components/Icon.svelte';
  import LevelPanel from '../../../lib/components/LevelPanel.svelte';
  import PageHead from '../../../lib/components/PageHead.svelte';
  import Section from '../../../lib/components/Section.svelte';
  import { formatDateTime } from '../../../lib/format-datetime.ts';
  import { formatCount } from '../../../lib/format.ts';
  import { isUnauthenticated, loginUrl } from '../../../lib/login-redirect.ts';
  import { t } from '../../../lib/vocabulary.svelte.ts';
  import type { ExperienceAction } from '../../../shared/experience.ts';
  import type { OutputOf } from '../../../shared/operations/define.ts';
  import {
    experienceGrants,
    experienceSummary,
    type ExperienceGrant,
  } from '../../../shared/operations/experience/index.ts';
  import type { DictionaryKey } from '../../../shared/vocabulary.ts';
  import type { PageProps } from './$types';

  // 自分の設定の画面（me.html）。今は経験値と API トークン（ApiTokensSetting）の節だけの骨組みで、ほかの節（1日の基準、稼働期間、休み、月の基準の上書き、テーマ、
  // 届いた招待、配分の知らせ、積載量の合計）は #70 で足す（まだ無いことを本文の先頭に1行で知らせる）。
  // 横（layout-side）にレベルの面（LevelPanel。合計、レベル、次のレベルまで、見込み、ゲージ、ワークスペースごとの内訳）、
  // その下に「経験値の明細」の節（説明を表の上に置き、表は画面の幅いっぱいに出す。5列の表を横の面と並べると、
  // PC の幅でも押しつぶされるため。確定日時、ワークスペース、行動、内容、値。
  // 新しい順に 50 件ずつ。760px 以下は行を縦に積む）。
  // 「続きを読む」で次の 50 件を足し、最後まで読んだらその旨を出す。続きの読み込みの失敗は、表を残したまま知らせて、同じボタンで読み直す。
  // 面と明細は別々に読み、読めなかった方にだけ「もう一度試す」を出す。読み直すのはその節の操作だけで、もう一方の節の値
  // （「続きを読む」で足した明細の行を含む）は捨てない。読めたら、その節の題へフォーカスを移す。
  // 経験値の数値と明細は本人にだけ見える（API が呼んだ人の分だけを返す）。今所属していないワークスペースの明細は、内容を伏せて返る
  let { data }: PageProps = $props();

  type Summary = OutputOf<typeof experienceSummary>;
  type GrantsPage = OutputOf<typeof experienceGrants>;
  type RetryState = 'idle' | 'retrying' | 'failed';

  const LEDGER_ID = 'me-experience';

  const slug = $derived(page.params.slug ?? '');
  const me = $derived(data.organization?.me ?? null);

  // 面と明細の今の値。load が読み直したら（画面の移動）その値に戻し、「もう一度試す」はそれぞれの節だけを書き換える
  let summary = $state<Summary | null>(null);
  let firstPage = $state<GrantsPage | null>(null);
  // 「続きを読む」で足した行と、次の位置（undefined は、まだ続きを読んでいない）
  let moreRows = $state<ExperienceGrant[]>([]);
  let moreNext = $state<{ confirmed_at: string; id: string } | null | undefined>(undefined);
  let loadingMore = $state(false);
  let loadMoreFailed = $state(false);
  let summaryRetry = $state<RetryState>('idle');
  // 「もう一度試す」で面が読めたら true。ゲージを伸ばさず今の値で出す（読み直しでは再生しない）。
  // 画面を開き直すまで戻さない（false へ戻すと animation の打ち消しが外れて、伸びが始まる）
  let summaryRetried = $state(false);
  let grantsRetry = $state<RetryState>('idle');
  // 古い応答を捨てるための番号。load の値が替わるたびと、明細を最初から読み直すたびに進める（リアクティブにしない）
  let dataEpoch = 0;
  let grantsEpoch = 0;

  $effect.pre(() => {
    summary = data.summary;
    firstPage = data.grants;
    moreRows = [];
    moreNext = undefined;
    loadingMore = false;
    loadMoreFailed = false;
    summaryRetry = 'idle';
    grantsRetry = 'idle';
    dataEpoch++;
    grantsEpoch++;
  });

  const rows = $derived(firstPage === null ? [] : [...firstPage.grants, ...moreRows]);
  const next = $derived(moreNext === undefined ? (firstPage?.next ?? null) : moreNext);

  let levelPanel = $state<ReturnType<typeof LevelPanel>>();
  let allLoadedNote = $state<HTMLElement>();

  function toLogin(): void {
    window.location.assign(loginUrl(page.url));
  }

  async function loadMore(): Promise<void> {
    if (loadingMore || next === null) return;
    const token = grantsEpoch;
    loadingMore = true;
    loadMoreFailed = false;
    const result = await callOperation(experienceGrants, { before: next }, { slug });
    // 待つ間に読み直した（画面の移動、明細の「もう一度試す」）なら、古い応答は捨てる
    if (token !== grantsEpoch) return;
    loadingMore = false;
    if (!result.ok && isUnauthenticated(result)) {
      toLogin();
      return;
    }
    if (!result.ok) {
      loadMoreFailed = true;
      return;
    }
    moreRows = [...moreRows, ...result.data.grants];
    moreNext = result.data.next;
    // 最後まで読んで押したボタンが消えたら、フォーカスを「すべて表示しました」へ移す
    if (result.data.next === null) {
      await tick();
      allLoadedNote?.focus();
    }
  }

  // レベルの面だけを読み直す。明細の行（続きで足した分を含む）はそのまま
  async function retrySummary(): Promise<void> {
    if (summaryRetry === 'retrying') return;
    const token = dataEpoch;
    summaryRetry = 'retrying';
    const result = await callOperation(experienceSummary, {}, { slug });
    if (token !== dataEpoch) return;
    if (!result.ok && isUnauthenticated(result)) {
      toLogin();
      return;
    }
    if (!result.ok) {
      summaryRetry = 'failed';
      return;
    }
    summaryRetried = true;
    summary = result.data;
    summaryRetry = 'idle';
    await tick();
    levelPanel?.focusTitle();
  }

  // 明細だけを最初の 50 件から読み直す
  async function retryGrants(): Promise<void> {
    if (grantsRetry === 'retrying') return;
    const token = ++grantsEpoch;
    grantsRetry = 'retrying';
    const result = await callOperation(experienceGrants, {}, { slug });
    if (token !== grantsEpoch) return;
    if (!result.ok && isUnauthenticated(result)) {
      toLogin();
      return;
    }
    if (!result.ok) {
      grantsRetry = 'failed';
      return;
    }
    firstPage = result.data;
    moreRows = [];
    moreNext = undefined;
    loadingMore = false;
    loadMoreFailed = false;
    grantsRetry = 'idle';
    await tick();
    const heading = document.getElementById(LEDGER_ID);
    heading?.setAttribute('tabindex', '-1');
    heading?.focus();
  }

  function retryStatus(state: RetryState): string {
    return state === 'retrying' ? t('retrying') : state === 'failed' ? t('retryFailed') : '';
  }

  const actionKeys: Record<ExperienceAction, DictionaryKey> = {
    task_created: 'xpActionTaskCreated',
    task_detailed: 'xpActionTaskDetailed',
    task_completed: 'xpActionTaskCompleted',
    review: 'xpActionReview',
    help: 'xpActionHelp',
    story_completed: 'xpActionStoryCompleted',
    epic_reward: 'xpActionEpicReward',
  };

  // 打ち消し（負の値）は、元の行動に「の打ち消し」を添える
  function actionLabel(grant: ExperienceGrant): string {
    const action = t(actionKeys[grant.action]);
    return grant.amount < 0 ? t('xpActionReversal', { action }) : action;
  }

  function amountLabel(amount: number): string {
    return amount > 0 ? t('xpPlus', { value: formatCount(amount) }) : formatCount(amount);
  }
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('pageMe'), app: t('appName') })}</title>
</svelte:head>

{#snippet summaryRetryActions()}
  <button
    class="btn is-sm"
    type="button"
    aria-label={t('retrySection', { section: t('levelPanelTitle') })}
    aria-disabled={summaryRetry === 'retrying'}
    onclick={retrySummary}>{t('retry')}</button
  >
  <span class="field-hint" role="status">{retryStatus(summaryRetry)}</span>
{/snippet}

{#snippet grantsRetryActions()}
  <button
    class="btn is-sm"
    type="button"
    aria-label={t('retrySection', { section: t('meExperienceTitle') })}
    aria-disabled={grantsRetry === 'retrying'}
    onclick={retryGrants}>{t('retry')}</button
  >
  <span class="field-hint" role="status">{retryStatus(grantsRetry)}</span>
{/snippet}

<PageHead title={t('pageMe')} eyebrow={me?.name} />

<!-- 本文（#70 で設定の節を足す）と横のレベルの面。API トークンと経験値の明細は表を持つので、この下に画面の幅いっぱいに出す
     （5列の表を横の面と並べると、PC の幅でも押しつぶされるため。.setting は見出しの列も取るので使わず、どちらも Section で出す） -->
<div class="layout-aside">
  <div class="layout-main">
    <p class="action-note">{t('meOtherSettingsNote')}</p>
  </div>
  <aside class="layout-side">
    {#if summary !== null}
      <LevelPanel
        bind:this={levelPanel}
        total={summary.total}
        prospective={summary.prospective}
        workspaces={summary.workspaces}
        thanksReceived={summary.thanks_received}
        still={summaryRetried}
      />
    {:else}
      <section class="panel" aria-labelledby="me-level-failed">
        <div class="panel-title"><h2 id="me-level-failed">{t('levelPanelTitle')}</h2></div>
        <EmptyState
          icon="alert"
          title={t('levelLoadFailed')}
          text={t('loadFailedText')}
          actions={summaryRetryActions}
        />
      </section>
    {/if}
  </aside>
</div>

<ApiTokensSetting initial={data.tokens} />

<Section id={LEDGER_ID} title={t('meExperienceTitle')}>
  <p class="action-note">{t('meExperienceDescription')}</p>
  {#if firstPage === null}
    <EmptyState icon="alert" title={t('xpLedgerFailedTitle')} text={t('loadFailedText')} actions={grantsRetryActions} />
  {:else if rows.length === 0}
    <EmptyState
      icon="crystal"
      iconTone="xp"
      art="chest"
      title={t('xpEmptyTitle')}
      text={t('xpEmptyText', { task: t('task'), complete: t('complete'), done: t('done') })}
    />
  {:else}
    <div class="table-wrap">
      <!-- 760px 以下は is-stacked で行を縦に積み、data-label を値の前に出す -->
      <table class="table is-stacked" aria-label={t('meExperienceTitle')}>
        <thead>
          <tr>
            <th>{t('xpHeaderConfirmedAt')}</th>
            <th>{t('workspace')}</th>
            <th>{t('xpHeaderAction')}</th>
            <th class="is-name">{t('xpHeaderContent')}</th>
            <th class="is-num"><Icon name="crystal" tone="xp" /> {t('xpUnit')}</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as grant (grant.id)}
            <tr>
              <td class="mono" data-label={t('xpHeaderConfirmedAt')}>{formatDateTime(grant.confirmed_at)}</td>
              <td class="wrap-anywhere" data-label={t('workspace')}>{grant.workspace_name}</td>
              <td data-label={t('xpHeaderAction')}><span class="tag">{actionLabel(grant)}</span></td>
              <td class="is-name wrap-anywhere" data-label={t('xpHeaderContent')}>
                {#if grant.content_hidden}
                  <span class="props-note">{t('xpContentHidden', { workspace: t('workspace') })}</span>
                {:else}
                  {grant.content ?? t('xpNoContent')}
                {/if}
              </td>
              <td class="is-num" data-label={t('xpUnit')}
                ><span class="xp-delta" class:is-minus={grant.amount < 0}>{amountLabel(grant.amount)}</span></td
              >
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    <!-- 続きを読んでいる間を読み上げに伝える。領域は常に置き、中の文字だけを替える -->
    <span class="visually-hidden" role="status">{loadingMore ? t('loading') : ''}</span>
    <!-- 続きの失敗も、領域を常に置いて文字だけを入れる（領域と文字を同時に描くと、読み上げないことがあるため） -->
    <span class="visually-hidden" role="alert">{next !== null && loadMoreFailed ? t('xpLoadMoreFailed') : ''}</span>
    {#if next !== null}
      {#if loadMoreFailed}
        <div class="callout is-warn" aria-hidden="true">
          <Icon name="alert" /><span>{t('xpLoadMoreFailed')}</span>
        </div>
      {/if}
      <div class="form-actions">
        <button class="btn is-sm" type="button" aria-disabled={loadingMore} onclick={loadMore}>
          {loadingMore ? t('loading') : t('xpLoadMore')}
        </button>
      </div>
    {:else}
      <!-- tabindex="-1" は、最後まで読んでボタンが消えた後に、プログラムからフォーカスを置くため -->
      <p class="field-hint" tabindex="-1" bind:this={allLoadedNote}>{t('xpAllLoaded')}</p>
    {/if}
  {/if}
</Section>
