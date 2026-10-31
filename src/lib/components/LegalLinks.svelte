<script lang="ts">
  import { resolve } from '$app/paths';
  import { t } from '../vocabulary.svelte.ts';

  // 利用規約とプライバシーポリシーへのリンクの組（ログインの画面と招待の画面の紙の下）。ログインしていなくても開ける画面。
  // newTab は、離れると中身が消える画面（招待の画面は、URL の秘密を、別の画面へ移るときに消す）で、元の画面を残すために新しいタブで開く。
  // 押せる範囲は、.form-actions の小さいボタンの規則で、狭い幅でも 44px 四方以上になる。
  // role="navigation" の領域（nav）にしない: 枠の外の画面は、左のメニューを持たず、ナビゲーションの領域が 0 であることを前提にしている
  let { newTab = false }: { newTab?: boolean } = $props();
  const target = $derived(newTab ? '_blank' : undefined);
  const rel = $derived(newTab ? 'noopener noreferrer' : undefined);
</script>

<div class="form-actions" role="group" aria-label={t('legalLinksLabel')}>
  <a class="btn is-sm is-quiet" href={resolve('/terms')} {target} {rel}
    >{t('termsTitle')}{#if newTab}<span class="visually-hidden">（{t('legalNewTab')}）</span>{/if}</a
  >
  <a class="btn is-sm is-quiet" href={resolve('/privacy')} {target} {rel}
    >{t('privacyTitle')}{#if newTab}<span class="visually-hidden">（{t('legalNewTab')}）</span>{/if}</a
  >
</div>
