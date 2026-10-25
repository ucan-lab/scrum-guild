<script lang="ts" module>
  // SectionLoad のうち、表示が読む部分
  export interface SectionStatus {
    readonly state: 'loading' | 'ready' | 'failed';
    readonly refreshFailed: boolean;
    readonly retrying: boolean;
    readonly retryFailed: boolean;
    retry(): Promise<void>;
  }
</script>

<script lang="ts">
  import { onMount, tick, type Snippet } from 'svelte';
  import { t } from '../../vocabulary.svelte.ts';
  import EmptyState from '../EmptyState.svelte';
  import Icon from '../Icon.svelte';

  // 組織の管理の画面の節の、読み込みの表示（共通）。節の部品（WorkspacesSetting など）は、中身（一覧と操作）だけを children で渡す。
  // - 読み込み中: 「読み込んでいます」。読み上げには、常に置いた role="status" の領域へ、描いた次のフレームで文字を入れて伝える。
  // - 初回の読み込みの失敗: failedTitle と「もう一度試す」。
  // - 読み直しの失敗: 今の中身を残したまま、先頭に refreshFailedText と「もう一度試す」の囲み（.callout の操作付き）を出す。
  //   失敗の知らせ（role="alert"）と、読み直している間の状態（role="status"）は入れ子にしない。
  // 「もう一度試す」で読み直せたら、押したボタンが消えるので、フォーカスを中身へ移す。
  let {
    section,
    failedTitle,
    refreshFailedText,
    children,
  }: { section: SectionStatus; failedTitle: string; refreshFailedText: string; children: Snippet } = $props();

  let body = $state<HTMLElement>();
  // 領域を描いた次のフレームで、文字を入れる。領域と文字が同じ描画で入ると、読み上げられないことがあるため。
  // 取り外されるときは、まだ来ていないフレームを取り消す
  let mounted = $state(false);
  onMount(() => {
    const frame = requestAnimationFrame(() => {
      mounted = true;
    });
    return () => cancelAnimationFrame(frame);
  });
  const loadingAnnouncement = $derived(mounted && section.state === 'loading' ? t('loading') : '');

  const retryStatus = $derived(section.retrying ? t('retrying') : section.retryFailed ? t('retryFailed') : '');

  async function retry(): Promise<void> {
    await section.retry();
    await tick();
    if (section.state === 'ready' && !section.refreshFailed) body?.focus();
  }
</script>

{#snippet retryActions()}
  <button class="btn is-sm" type="button" aria-disabled={section.retrying} onclick={retry}>{t('retry')}</button>
  <span class="field-hint" role="status">{retryStatus}</span>
{/snippet}

<!-- 初回の読み込み中を読み上げに伝える。領域は常に置き、描いた後に中の文字だけを替える（最初から文字が入っていると読み上げられないことがある） -->
<span class="visually-hidden" role="status">{loadingAnnouncement}</span>

{#if section.state === 'loading'}
  <EmptyState icon="clock" title={t('loading')} />
{:else if section.state === 'failed'}
  <EmptyState icon="alert" title={failedTitle} text={t('loadFailedText')} actions={retryActions} />
{:else}
  <!-- tabindex="-1" は、読み直せた後にプログラムからフォーカスを置くため（キーボードの Tab 順には入らない） -->
  <div class="setting-body" tabindex="-1" bind:this={body}>
    {#if section.refreshFailed}
      <div class="callout is-warn">
        <Icon name="alert" /><span role="alert">{refreshFailedText}</span>
        <div class="callout-actions">{@render retryActions()}</div>
      </div>
    {/if}
    {@render children()}
  </div>
{/if}
