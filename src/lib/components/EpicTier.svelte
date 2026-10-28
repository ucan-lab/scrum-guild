<script lang="ts">
  import type { EpicRewardTier } from '../../shared/experience.ts';
  import { t } from '../vocabulary.svelte.ts';

  // kit.js の tier。クリア報酬の段階と額の印（components.css の .tier）。額は API が返した値（epic-detail の reward_xp）を出す。
  // 色だけに頼らず、段階の呼び名（小、中、大）と額を文字で添える
  let { tier, xp }: { tier: EpicRewardTier; xp: number } = $props();

  const label = $derived(
    tier === 'small' ? t('epicTierSmall') : tier === 'medium' ? t('epicTierMedium') : t('epicTierLarge'),
  );
</script>

<span class="tier is-{tier}">{label} · <b>{xp}</b> {t('xpUnit')}</span>
