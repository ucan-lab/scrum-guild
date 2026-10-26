<script lang="ts">
  import { tick } from 'svelte';
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { callOperation } from '../../../lib/api.ts';
  import EmptyState from '../../../lib/components/EmptyState.svelte';
  import Icon from '../../../lib/components/Icon.svelte';
  import LevelPanel from '../../../lib/components/LevelPanel.svelte';
  import PageHead from '../../../lib/components/PageHead.svelte';
  import Setting from '../../../lib/components/Setting.svelte';
  import { formatDateTime } from '../../../lib/format-datetime.ts';
  import { formatCount } from '../../../lib/format.ts';
  import { isUnauthenticated, loginUrl } from '../../../lib/login-redirect.ts';
  import { t } from '../../../lib/vocabulary.svelte.ts';
  import type { ExperienceAction } from '../../../shared/experience.ts';
  import { experienceGrants, type ExperienceGrant } from '../../../shared/operations/experience/index.ts';
  import type { DictionaryKey } from '../../../shared/vocabulary.ts';
  import type { PageProps } from './$types';

  // 自分の設定の画面（me.html）。今は経験値の節だけの骨組みで、ほかの節（1日の基準、稼働期間、休み、月の基準の上書き、テーマ、
  // 届いた招待、配分の知らせ、積載量の合計）は #70 で足す。
  // 横（layout-side）にレベルの面（LevelPanel。合計、レベル、次のレベルまで、見込み、ゲージ、ワークスペースごとの内訳）、
  // 本文に「経験値の明細」の表（確定日時、ワークスペース、行動、内容、値。新しい順に 50 件ずつ）。
  // 「続きを読む」で次の 50 件を足し、最後まで読んだらその旨を出す。続きの読み込みの失敗は、表を残したまま知らせて、同じボタンで読み直す。
  // 面と表は別々に読み、読めなかった方にだけ「もう一度試す」を出す（app:me-experience を読み直す）。
  // 経験値の数値と明細は本人にだけ見える（API が呼んだ人の分だけを返す）
  let { data }: PageProps = $props();

  const slug = $derived(page.params.slug ?? '');
  const me = $derived(data.organization?.me ?? null);
  const summary = $derived(data.summary);

  // 「続きを読む」で足した行と、次の位置。load が読み直したら（もう一度試す、画面の移動）捨てる
  let moreRows = $state<ExperienceGrant[]>([]);
  let moreNext = $state<{ confirmed_at: string; id: string } | null | undefined>(undefined);
  let loadingMore = $state(false);
  let loadMoreFailed = $state(false);
  $effect.pre(() => {
    void data.grants;
    moreRows = [];
    moreNext = undefined;
    loadingMore = false;
    loadMoreFailed = false;
  });

  const rows = $derived(data.grants === null ? [] : [...data.grants.grants, ...moreRows]);
  const next = $derived(moreNext === undefined ? (data.grants?.next ?? null) : moreNext);

  let allLoadedNote = $state<HTMLElement>();

  async function loadMore(): Promise<void> {
    if (loadingMore || next === null) return;
    const grantsAtStart = data.grants;
    loadingMore = true;
    loadMoreFailed = false;
    try {
      const result = await callOperation(experienceGrants, { before: next }, { slug });
      // 待つ間に読み直した（もう一度試す、画面の移動）なら、古い応答は捨てる
      if (data.grants !== grantsAtStart) return;
      if (!result.ok && isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url, result));
        return;
      }
      if (!result.ok) {
        loadMoreFailed = true;
        return;
      }
      moreRows = [...moreRows, ...result.data.grants];
      moreNext = result.data.next;
    } finally {
      if (data.grants === grantsAtStart) loadingMore = false;
    }
    // 最後まで読んで押したボタンが消えたら、フォーカスを「すべて表示しました」へ移す
    if (next === null) {
      await tick();
      allLoadedNote?.focus();
    }
  }

  // 読み込めなかった節の「もう一度試す」。読み直している間は押しても無視し、また失敗したら知らせる
  let retrying = $state(false);
  let retried = $state(false);
  async function retry(): Promise<void> {
    if (retrying) return;
    retrying = true;
    try {
      await invalidate('app:me-experience');
    } finally {
      retrying = false;
      retried = true;
    }
  }
  const retryStatus = $derived(retrying ? t('retrying') : retried ? t('retryFailed') : '');

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

{#snippet retryActions()}
  <button class="btn is-sm" type="button" aria-disabled={retrying} onclick={retry}>{t('retry')}</button>
  <span class="field-hint" role="status">{retryStatus}</span>
{/snippet}

<PageHead title={t('pageMe')} eyebrow={me?.name} />

<div class="layout-aside">
  <div class="layout-main">
    <div class="settings">
      <Setting title={t('meExperienceTitle')} description={t('meExperienceDescription')}>
        {#if data.grants === null}
          <EmptyState icon="alert" title={t('xpLedgerFailedTitle')} text={t('loadFailedText')} actions={retryActions} />
        {:else if rows.length === 0}
          <EmptyState icon="trend" title={t('xpEmptyTitle')} text={t('xpEmptyText', { task: t('task') })} />
        {:else}
          <div class="table-wrap">
            <table class="table" aria-label={t('meExperienceTitle')}>
              <thead>
                <tr>
                  <th>{t('xpHeaderConfirmedAt')}</th>
                  <th>{t('workspace')}</th>
                  <th>{t('xpHeaderAction')}</th>
                  <th class="is-name">{t('xpHeaderContent')}</th>
                  <th class="is-num">{t('xpUnit')}</th>
                </tr>
              </thead>
              <tbody>
                {#each rows as grant (grant.id)}
                  <tr>
                    <td class="mono">{formatDateTime(grant.confirmed_at)}</td>
                    <td>{grant.workspace_name}</td>
                    <td><span class="tag">{actionLabel(grant)}</span></td>
                    <td class="is-name">{grant.content ?? t('xpNoContent')}</td>
                    <td class="is-num"
                      ><span class="xp-delta" class:is-minus={grant.amount < 0}>{amountLabel(grant.amount)}</span></td
                    >
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <!-- 続きを読んでいる間を読み上げに伝える。領域は常に置き、中の文字だけを替える -->
          <span class="visually-hidden" role="status">{loadingMore ? t('loading') : ''}</span>
          {#if next !== null}
            {#if loadMoreFailed}
              <div class="callout is-warn">
                <Icon name="alert" /><span role="alert">{t('xpLoadMoreFailed')}</span>
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
      </Setting>
    </div>
  </div>
  <aside class="layout-side">
    {#if summary !== null}
      <LevelPanel total={summary.total} prospective={summary.prospective} workspaces={summary.workspaces} />
    {:else}
      <section class="panel">
        <div class="panel-title"><b>{t('levelPanelTitle')}</b></div>
        <EmptyState icon="alert" title={t('levelLoadFailed')} text={t('loadFailedText')} actions={retryActions} />
      </section>
    {/if}
  </aside>
</div>
