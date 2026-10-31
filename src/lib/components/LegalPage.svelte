<script lang="ts">
  import { afterNavigate } from '$app/navigation';
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
  // 本文の末尾の「改定日: …」の行は描かず（documents.ts の body）、改定日（版）は紙の上に1か所だけ出す。
  // `#` を条の見出しにし、画面の見出し（h1）の次の段（h2）で描く。
  // 2つのページの間の行き来は、Markdown の中でなく、ここで置く
  // （Markdown のリンクは http と https の絶対 URL に限られ、画面の経路を書けないため）。
  // 元の画面への戻り: アプリの中から移ってきたとき（afterNavigate の from がある）は「前の画面に戻る」（履歴を戻る。
  // /login?return_to=… のようなクエリごと元に戻る）。直に開いたとき（新しいタブ、URL を直に開く）は戻る先が無いので、
  // / へのリンク（未ログインなら / の load がログインへ移す）にする
  let { kind }: { kind: LegalKind } = $props();

  const doc = $derived(legalDocuments[kind]);
  const blocks = $derived(parseMarkdown(doc.body));
  const title = $derived(t(kind === 'terms' ? 'termsTitle' : 'privacyTitle'));

  let cameFromApp = $state(false);
  afterNavigate(({ from }) => {
    cameFromApp = from !== null;
  });
</script>

<svelte:head>
  <title>{t('pageTitle', { page: title, app: t('appName') })}</title>
</svelte:head>

<Gate reading>
  <GateSheet brand {title}>
    <p>{t('legalRevised', { date: doc.version })}</p>
    {#if blocks}
      <MarkdownBlocks {blocks} headingStart={2} />
    {:else}
      <MarkdownPlain source={doc.body} />
    {/if}
    <div class="form-actions" role="group" aria-label={t('legalPageLinksLabel')}>
      {#if kind === 'terms'}
        <a class="btn is-sm" href={resolve('/privacy')}>{t('privacyTitle')}</a>
      {:else}
        <a class="btn is-sm" href={resolve('/terms')}>{t('termsTitle')}</a>
      {/if}
      {#if cameFromApp}
        <button class="btn is-sm is-quiet" type="button" onclick={() => history.back()}>{t('legalBack')}</button>
      {:else}
        <a class="btn is-sm is-quiet" href={resolve('/')}>{t('legalOpenApp', { app: t('appName') })}</a>
      {/if}
    </div>
  </GateSheet>
</Gate>
