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
  import { page } from '$app/state';
  import AppShell from '../lib/components/AppShell.svelte';
  import DevSwitches from '../lib/components/DevSwitches.svelte';
  import IconSprite from '../lib/components/IconSprite.svelte';
  import ToastRegion from '../lib/components/ToastRegion.svelte';

  let { children }: { children: Snippet } = $props();
</script>

<IconSprite />
<AppShell current={page.url.pathname}>
  {#snippet tools()}
    <!-- 開発用の切り替え。import.meta.env.DEV は build で false に置き換わり、DevSwitches ごと束から外れる -->
    {#if import.meta.env.DEV}<DevSwitches />{/if}
  {/snippet}
  {@render children()}
</AppShell>
<ToastRegion />
