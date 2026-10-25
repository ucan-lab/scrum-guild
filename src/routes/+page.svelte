<script lang="ts">
  import { getHealth } from '../lib/api.ts';
  import Dialog from '../lib/components/Dialog.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import PageHead from '../lib/components/PageHead.svelte';
  import Section from '../lib/components/Section.svelte';
  import { showToast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/vocabulary.svelte.ts';

  // 土台の仮の画面（#53 で自分の今日に置き換える）。枠と見出しと空の状態を部品で組み、
  // API と画面がつながったことを示す。文言はすべて辞書を通す。
  // 今日やるタスクは API から取っていないので、件数や「所属すると並ぶ」といった事実は書かない
  let health = $state(getHealth());
  let checking = $state(false);
  let detailOpen = $state(false);
  let detailDialog = $state<ReturnType<typeof Dialog>>();

  // 結果が出てから、成功と失敗を分けて知らせる。確かめている間は押せない
  async function recheck(): Promise<void> {
    checking = true;
    const next = getHealth();
    health = next;
    const result = await next.catch(() => null);
    checking = false;
    if (result?.ok) showToast(t('apiRecheckOk'), 'check');
    else showToast(t('apiRecheckFailed'), 'alert');
  }
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('pageToday'), app: t('appName') })}</title>
</svelte:head>

<PageHead title={t('pageToday')} />

<Section id="s-today" title={t('sectionToday')} hint={t('sectionTodayHint')}>
  <EmptyState icon="sun" title={t('todayEmptyTitle')} text={t('todayEmptyText')} />
</Section>

<Section id="s-api" title={t('apiHeading')}>
  <p role="status" class="wrap-anywhere">
    {#await health}
      {t('apiChecking')}
    {:then result}
      {#if result.ok}
        {t('apiStatus', { status: result.data.status, version: result.data.version })}
      {:else}
        {t('apiUnreachableStatus', { status: result.status })}
      {/if}
    {:catch}
      {t('apiUnreachable')}
    {/await}
  </p>
  <div class="form-actions">
    <!-- Safari と Firefox はクリックでボタンにフォーカスを移さないので、開く操作を起こしたボタンを渡す -->
    <button class="btn is-sm" type="button" onclick={(event) => detailDialog?.show(event.currentTarget)}>
      {t('apiShowDetail')}
    </button>
    <button class="btn is-sm" type="button" disabled={checking} onclick={recheck}>{t('apiRecheck')}</button>
  </div>
</Section>

<Dialog bind:this={detailDialog} bind:open={detailOpen} title={t('apiDetailTitle')}>
  <p>{t('apiDetailBody')}</p>
  <!-- ダイアログは閉じていても中身を描くので、ここでも拒否を受けないと処理されない例外になる -->
  {#await health then result}
    <p class="mono wrap-anywhere">{JSON.stringify(result)}</p>
  {:catch}
    <p>{t('apiUnreachable')}</p>
  {/await}
  {#snippet footer(close)}
    <button class="btn" type="button" disabled={checking} onclick={recheck}>{t('apiRecheck')}</button>
    <button class="btn is-primary" type="button" onclick={close}>{t('close')}</button>
  {/snippet}
</Dialog>
