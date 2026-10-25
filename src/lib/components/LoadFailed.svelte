<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { t } from '../vocabulary.svelte.ts';
  import EmptyState from './EmptyState.svelte';
  import Gate from './Gate.svelte';
  import GateSheet from './GateSheet.svelte';

  // 読み込みに失敗した画面（通信の失敗、5xx、見つからない以外の 404 と 403）。見つからない画面とは分ける。
  // 「もう一度試す」は、読み直している間は aria-disabled にして、押しても無視する（フォーカスを残す）。
  // 状態は、常に置いた role="status" の領域の文字だけを替えて伝える。
  // 読み直しが終わっても、この画面が残っていれば、また失敗したということ（成功すれば画面ごと入れ替わる）
  let state = $state<'idle' | 'retrying' | 'failedAgain'>('idle');

  async function retry(): Promise<void> {
    if (state === 'retrying') return;
    state = 'retrying';
    try {
      await invalidateAll();
    } finally {
      state = 'failedAgain';
    }
  }

  const status = $derived(state === 'retrying' ? t('retrying') : state === 'failedAgain' ? t('retryFailed') : '');
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('loadFailedTitle'), app: t('appName') })}</title>
</svelte:head>

<Gate>
  <GateSheet brand title={t('loadFailedTitle')}>
    <EmptyState icon="alert" title={t('loadFailedText')}>
      {#snippet actions()}
        <button class="btn is-sm" type="button" aria-disabled={state === 'retrying'} onclick={retry}>
          {t('retry')}
        </button>
        <span class="field-hint" role="status">{status}</span>
      {/snippet}
    </EmptyState>
  </GateSheet>
</Gate>
