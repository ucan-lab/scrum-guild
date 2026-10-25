<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { t } from '../vocabulary.svelte.ts';
  import EmptyState from './EmptyState.svelte';
  import Gate from './Gate.svelte';
  import GateSheet from './GateSheet.svelte';

  // 読み込みに失敗した画面（通信の失敗、5xx、見つからない以外の 404 と 403）。見つからない画面とは分ける。
  // 「もう一度試す」は、読み直している間は押せず、文言を替える
  let retrying = $state(false);

  async function retry(): Promise<void> {
    retrying = true;
    try {
      await invalidateAll();
    } finally {
      retrying = false;
    }
  }
</script>

<Gate>
  <GateSheet brand title={t('loadFailedTitle')}>
    <EmptyState icon="alert" title={t('loadFailedText')}>
      {#snippet actions()}
        <button class="btn is-sm" type="button" disabled={retrying} onclick={retry}>
          {retrying ? t('retrying') : t('retry')}
        </button>
      {/snippet}
    </EmptyState>
  </GateSheet>
</Gate>
