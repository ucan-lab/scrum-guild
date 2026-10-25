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
  import Avatar from '../lib/components/Avatar.svelte';
  import DevSwitches from '../lib/components/DevSwitches.svelte';
  import IconSprite from '../lib/components/IconSprite.svelte';
  import ToastRegion from '../lib/components/ToastRegion.svelte';
  import { t } from '../lib/vocabulary.svelte.ts';

  let { children }: { children: Snippet } = $props();

  // ログインした人の代わりの仮の利用者（架空の ID）。ログインを作る Issue（#50 から #53）で本物に替える
  const placeholderUserId = '0196f1a2-7b3c-7d4e-8f5a-000000000001';
</script>

<!-- 開発用の切り替え。import.meta.env.DEV は build で false に置き換わり、tools に何も渡らなくなる。
     テーマと言葉のストアは本番でも使う（#53）ので、モジュールは束に残る -->
{#snippet devTools()}<DevSwitches />{/snippet}

{#snippet account()}
  <span class="me"><Avatar userId={placeholderUserId} name={t('placeholderUserName')} />{t('placeholderUserName')}</span
  >
{/snippet}

<IconSprite />
<AppShell current={page.url.pathname} tools={import.meta.env.DEV ? devTools : undefined} {account}>
  {@render children()}
</AppShell>
<ToastRegion />
