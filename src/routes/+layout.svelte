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
  import IconSprite from '../lib/components/IconSprite.svelte';
  import ToastRegion from '../lib/components/ToastRegion.svelte';

  let { children }: { children: Snippet } = $props();
</script>

<!-- 全画面に共通のものだけを置く。左のメニューと上の帯の枠は /[slug] のレイアウト（ログインと組織の選択には枠を出さない） -->
<IconSprite />
{@render children()}
<ToastRegion />
