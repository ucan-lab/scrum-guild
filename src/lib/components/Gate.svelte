<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { resetToDefaults } from '../organization.svelte.ts';

  // 枠の外の画面（組織の選択、見つからない、読み込みの失敗、運用）の外側。中に GateSheet を縦に並べる。
  // 画面の本文なので main にする。組織の外の画面は、どの組織の値も持ち越さず、テーマと言葉づかいを既定に戻す。
  // wide は表を載せる画面（運用）で、紙の幅を広げる。
  // keepsOrganization は、組織の中で枠を持たない画面（招待の画面）で、組織のテーマと言葉づかいを既定に戻さない
  let {
    wide = false,
    keepsOrganization = false,
    children,
  }: { wide?: boolean; keepsOrganization?: boolean; children: Snippet } = $props();

  onMount(() => {
    if (!keepsOrganization) resetToDefaults();
  });
</script>

<main class="gate" class:is-wide={wide}>
  <div class="gate-stack">{@render children()}</div>
</main>
