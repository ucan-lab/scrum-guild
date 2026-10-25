<script lang="ts">
  import { getHealth } from '../lib/api.ts';
  import Dialog from '../lib/components/Dialog.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';
  import PageHead from '../lib/components/PageHead.svelte';
  import Section from '../lib/components/Section.svelte';
  import { showToast } from '../lib/toast.svelte.ts';
  import { t } from '../lib/vocabulary.svelte.ts';

  // 土台の仮の画面（#53 で自分の今日に置き換える）。枠と見出しと空の状態を部品で組み、
  // API と画面がつながったことを示す。文言はすべて辞書を通す
  let health = $state(getHealth());
  let detailOpen = $state(false);

  function recheck(): void {
    health = getHealth();
    showToast(t('apiRechecked'), 'check');
  }
</script>

<svelte:head>
  <title>{t('appName')}</title>
</svelte:head>

<PageHead title={t('pageToday')} />

<Section id="s-today" title={t('sectionToday')} count={0} hint={t('sectionTodayHint')}>
  <EmptyState icon="sun" title={t('todayEmptyTitle')} text={t('todayEmptyText')} />
</Section>

<Section id="s-api" title={t('apiHeading')}>
  <p role="status">
    {#await health}
      {t('apiChecking')}
    {:then result}
      {#if result.ok}
        {t('apiLabel')}: {result.data.status}（{t('apiVersion')} {result.data.version}）
      {:else}
        {t('apiUnreachable')}（{result.status}）
      {/if}
    {:catch}
      {t('apiUnreachable')}
    {/await}
  </p>
  <div class="form-actions">
    <button class="btn is-sm" type="button" onclick={() => (detailOpen = true)}>{t('apiShowDetail')}</button>
    <button class="btn is-sm" type="button" onclick={recheck}>{t('apiRecheck')}</button>
  </div>
</Section>

<Dialog bind:open={detailOpen} title={t('apiDetailTitle')}>
  <p>{t('apiDetailBody')}</p>
  {#await health then result}
    <p class="mono">{JSON.stringify(result)}</p>
  {/await}
  {#snippet footer(close)}
    <button class="btn is-primary" type="button" onclick={close}>{t('close')}</button>
  {/snippet}
</Dialog>
