<script lang="ts">
  import '@fontsource/biz-udpgothic/400.css';
  import '@fontsource/biz-udpgothic/700.css';
  import '@fontsource/chakra-petch/500.css';
  import '@fontsource/chakra-petch/600.css';
  import '@fontsource/chakra-petch/700.css';
  import '@fontsource/ibm-plex-mono/400.css';
  import '@fontsource/ibm-plex-mono/500.css';
  import '@fontsource/zen-old-mincho/700.css';
  import '@fontsource/zen-old-mincho/900.css';
  import '../../design/tokens.css';
  import '../../design/components.css';
  import type { Snippet } from 'svelte';
  import { navigating } from '$app/state';
  import IconSprite from '../lib/components/IconSprite.svelte';
  import LoadingSheet from '../lib/components/LoadingSheet.svelte';
  import ToastRegion from '../lib/components/ToastRegion.svelte';
  import { t } from '../lib/vocabulary.svelte.ts';

  let { children }: { children: Snippet } = $props();

  // 枠の外の画面（組織の選択、見つからない、運用）から移る間は、読み込み中の表示を出す。
  // 組織の枠の中から移る間は、今の画面を残す（枠ごと消さない）。
  // 短い読み込みでは出さないよう、移り始めから SLOW_MS たっても終わらないときだけ出す
  const SLOW_MS = 300;
  const loadingFromOutside = $derived(navigating.to !== null && !navigating.from?.route.id?.startsWith('/[slug]'));
  let slow = $state(false);

  $effect(() => {
    if (!loadingFromOutside) return;
    const timer = setTimeout(() => (slow = true), SLOW_MS);
    return () => {
      clearTimeout(timer);
      slow = false;
    };
  });
</script>

<!-- 全画面に共通のものだけを置く。左のメニューと上の帯の枠は /[slug] のレイアウト（ログインと組織の選択には枠を出さない） -->
<IconSprite />
<!-- 読み込み中を読み上げに伝える。領域は常に置き、中の文字だけを替える -->
<div class="visually-hidden" role="status">{slow ? t('loading') : ''}</div>
{#if slow}
  <LoadingSheet />
{:else}
  {@render children()}
{/if}
<ToastRegion />
