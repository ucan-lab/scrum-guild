<script lang="ts">
  import { t } from '../vocabulary.svelte.ts';

  // kit.js の progress。完了 / 全体のポイントの進み具合の棒と数字。全体が 0 なら棒は空。
  // 棒の幅は style:width（CSSOM）で渡す。style 属性の文字列は CSP の style-src に止められる
  let { done, all }: { done: number; all: number } = $props();

  const percent = $derived(all > 0 ? Math.min(100, Math.round((done / all) * 100)) : 0);
</script>

<span class="progress">
  <span
    class="progress-bar"
    role="img"
    aria-label={t('progressLabel', { done: t('done'), value: done, all, points: t('points') })}
  >
    <span style:width={`${percent}%`}></span>
  </span>
  <span class="progress-num">{t('progressValue', { value: done, all })}</span>
</span>
