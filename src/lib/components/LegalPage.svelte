<script lang="ts">
  import { resolve } from '$app/paths';
  import { legalDocuments, type LegalKind } from '../legal/documents.ts';
  import { parseMarkdown } from '../markdown.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Gate from './Gate.svelte';
  import GateSheet from './GateSheet.svelte';
  import MarkdownBlocks from './MarkdownBlocks.svelte';
  import MarkdownPlain from './MarkdownPlain.svelte';

  // 利用規約（/terms）とプライバシーポリシー（/privacy）。ログインしていなくても開ける枠の外の画面で、API を呼ばない。
  // 本文は src/lib/legal/ の Markdown を、画面の側で同期に変換して描く（固定の短い文なので、Worker に頼まない。
  // 変換できなかったとき（出力の上限。文面を書き換えて超えたときだけ）は文字のまま出す）。
  // `#` を条の見出しにし、画面の見出し（h1）の次の段（h2）で描く。
  // 2つのページの間の行き来とログインへの戻りは、Markdown の中でなく、ここで置く
  // （Markdown のリンクは http と https の絶対 URL に限られ、画面の経路を書けないため）
  let { kind }: { kind: LegalKind } = $props();

  const doc = $derived(legalDocuments[kind]);
  const blocks = $derived(parseMarkdown(doc.source));
  const title = $derived(t(kind === 'terms' ? 'termsTitle' : 'privacyTitle'));
</script>

<svelte:head>
  <title>{t('pageTitle', { page: title, app: t('appName') })}</title>
</svelte:head>

<Gate reading>
  <GateSheet brand {title}>
    <p class="gate-note">{t('legalRevised', { date: doc.version })}</p>
    {#if blocks}
      <MarkdownBlocks {blocks} headingStart={2} />
    {:else}
      <MarkdownPlain source={doc.source} />
    {/if}
    <div class="form-actions" role="group" aria-label={t('legalPageLinksLabel')}>
      {#if kind === 'terms'}
        <a class="btn is-sm" href={resolve('/privacy')}>{t('privacyTitle')}</a>
      {:else}
        <a class="btn is-sm" href={resolve('/terms')}>{t('termsTitle')}</a>
      {/if}
      <a class="btn is-sm is-quiet" href={resolve('/login')}>{t('legalBackToLogin')}</a>
    </div>
  </GateSheet>
</Gate>
