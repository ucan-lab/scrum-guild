<script lang="ts">
  import { t } from '../vocabulary.svelte.ts';

  // kit.js の emblem。六角の紋章にレベルの数字。大（small なし）は自分の記録の面（LevelPanel）だけ、小は名前の横に添える。
  // 読み上げは「レベル N」。ほかの人に見せるのはレベルだけで、経験値の数値は渡さない
  let { level, small = false }: { level: number; small?: boolean } = $props();
</script>

<span class="emblem" class:is-sm={small} role="img" aria-label={t('levelLabel', { level })}>
  {#if small}<span>{level}</span>{:else}<span><small>{t('levelShort')}</small>{level}</span>{/if}
</span>
