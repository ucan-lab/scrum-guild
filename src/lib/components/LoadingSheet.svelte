<script lang="ts">
  import { t } from '../vocabulary.svelte.ts';
  import EmptyState from './EmptyState.svelte';
  import Gate from './Gate.svelte';
  import GateSheet from './GateSheet.svelte';

  // 枠の外の画面から移るときの、読み込みの最中の表示。読み上げには status として伝える
</script>

<Gate>
  <GateSheet brand>
    <div role="status">
      <EmptyState icon="clock" title={t('loading')} />
    </div>
  </GateSheet>
</Gate>
