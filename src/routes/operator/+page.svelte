<script lang="ts">
  import EmptyState from '../../lib/components/EmptyState.svelte';
  import Gate from '../../lib/components/Gate.svelte';
  import GateSheet from '../../lib/components/GateSheet.svelte';
  import { t } from '../../lib/vocabulary.svelte.ts';

  // 運用の画面の仮の置き場所（本物は運用の画面を作る Issue で置き換える）。
  // 入れる組織が無い運用者が、ログインの直後にここへ来る
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('pageOperator'), app: t('appName') })}</title>
</svelte:head>

<Gate>
  <GateSheet brand title={t('pageOperator')}>
    <EmptyState icon="shield" title={t('operatorEmptyTitle')} text={t('operatorEmptyText')} />
  </GateSheet>
</Gate>
