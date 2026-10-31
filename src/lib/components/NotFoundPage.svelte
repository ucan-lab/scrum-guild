<script lang="ts">
  import { resolve } from '$app/paths';
  import { t } from '../vocabulary.svelte.ts';
  import EmptyState from './EmptyState.svelte';
  import PageHead from './PageHead.svelte';

  // 組織の枠の中の「見つからない」画面。管理者でない人が開いた組織の管理、存在しない（別の組織の）ワークスペースに使う。
  // どちらも理由を分けずに同じ画面を出す。枠（左のメニューと上の帯）は残し、今日やることへ戻る道を置く
  let { slug, title, text }: { slug: string; title: string; text: string } = $props();
</script>

<svelte:head>
  <title>{t('pageTitle', { page: title, app: t('appName') })}</title>
</svelte:head>

<PageHead {title} />
<EmptyState icon="search" title={text}>
  {#snippet actions()}
    <a class="btn is-sm" href={resolve('/[slug]', { slug })}>{t('backToToday')}</a>
  {/snippet}
</EmptyState>
