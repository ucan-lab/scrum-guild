<script lang="ts">
  import { formatCount } from '../format.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // kit.js の teamXp。チーム全体の経験値（ワークスペースの全員の合計の1つの数）。人ごとの値は出さない。
  // 画面の見出し（PageHead の meta）の中、集計の下に置く。ラベルの前に経験値のアイコン（crystal）を置く
  let { total }: { total: number } = $props();
</script>

<p class="team-xp">
  <Icon name="crystal" tone="xp" />{t('teamXpLabel')}<b>{formatCount(total)}</b><small>{t('xpUnit')}</small>
</p>
