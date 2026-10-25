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

  let { children }: { children: Snippet } = $props();

  // 枠の外の画面（組織の選択、見つからない、運用）から移る間は、読み込み中の表示を出す。
  // 組織の枠の中から移る間は、今の画面を残す（枠ごと消さない）
  const loadingFromOutside = $derived(navigating.to !== null && !navigating.from?.route.id?.startsWith('/[slug]'));
</script>

<!-- 全画面に共通のものだけを置く。左のメニューと上の帯の枠は /[slug] のレイアウト（ログインと組織の選択には枠を出さない） -->
<IconSprite />
{#if loadingFromOutside}
  <LoadingSheet />
{:else}
  {@render children()}
{/if}
<ToastRegion />
