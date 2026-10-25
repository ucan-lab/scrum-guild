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
  import { tick, type Snippet } from 'svelte';
  import { t } from '../../vocabulary.svelte.ts';
  import EmptyState from '../EmptyState.svelte';
  import Icon from '../Icon.svelte';

  // 組織の管理の画面の節の、読み込みの表示（共通）。節の部品（WorkspacesSetting など）は、中身（一覧と操作）だけを children で渡す。
  // - 読み込み中: 「読み込んでいます」。
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
