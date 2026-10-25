<script lang="ts">
  import { t } from '../vocabulary.svelte.ts';
  import EmptyState from './EmptyState.svelte';
  import Gate from './Gate.svelte';
  import GateSheet from './GateSheet.svelte';

  // 枠の外の画面から移る間の、読み込み中の表示。見出しと題名を持つ。
  // 短い読み込みでは出さない（出す遅れと、読み上げの領域は呼ぶ側の root レイアウトが持つ）
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('loading'), app: t('appName') })}</title>
</svelte:head>

<Gate>
  <GateSheet brand title={t('loading')}>
    <EmptyState icon="clock" title={t('loadingText')} />
  </GateSheet>
</Gate>
