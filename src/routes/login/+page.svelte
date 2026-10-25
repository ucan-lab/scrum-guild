<script lang="ts">
  import { page } from '$app/state';
  import Gate from '../../lib/components/Gate.svelte';
  import GateSheet from '../../lib/components/GateSheet.svelte';
  import Icon from '../../lib/components/Icon.svelte';
  import { t } from '../../lib/vocabulary.svelte.ts';
  import type { DictionaryKey } from '../../shared/vocabulary.ts';
  import { safeReturnTo } from '../../shared/return-to.ts';

  // ログインの画面（枠の外）。ログインしていない人の移し先で、ログイン後に戻る先は return_to（自分のサイトのパス。
  // 無いか不正なら /）。ログインの開始は GET のリダイレクトなので、ボタンはリンクにして、画面の遷移を通さず直に開く。
  // ?error= はサーバーが付ける（src/server/auth/login-routes.ts の LoginError）。知らない値は出さない
  const errorMessages: Record<string, DictionaryKey> = {
    denied: 'loginErrorDenied',
    retry: 'loginErrorRetry',
    too_many: 'loginErrorTooMany',
    unavailable: 'loginErrorUnavailable',
  };

  const returnTo = $derived(safeReturnTo(page.url.searchParams.get('return_to')));
  const startHref = $derived(`/api/auth/github/start?return_to=${encodeURIComponent(returnTo)}`);
  // 自分のキーだけで引く（constructor や __proto__ のような継承したキーで、辞書に無い値を引かない）
  const errorKey = $derived.by(() => {
    const error = page.url.searchParams.get('error') ?? '';
    return Object.hasOwn(errorMessages, error) ? errorMessages[error] : undefined;
  });

  // ほかの文言に混ぜる言葉。organization と workspace と leader は辞書のそれぞれの項目
  const words = $derived({ organization: t('organization'), workspace: t('workspace'), leader: t('leader') });
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('loginTitle'), app: t('appName') })}</title>
</svelte:head>

<Gate>
  <GateSheet brand title={t('loginTitle')}>
    {#if errorKey}
      <div class="callout is-warn" role="alert"><Icon name="alert" /><span>{t(errorKey, words)}</span></div>
    {/if}
    <p>{t('loginLead', words)}</p>
    <!-- 画面の経路ではなく Worker の GET。resolve() は経路の ID を要るので通さず、data-sveltekit-reload で直に開く -->
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
    <a class="btn is-wide" href={startHref} data-sveltekit-reload><Icon name="git" />{t('loginWithGithub')}</a>
    <p class="gate-note">{t('loginNote', words)}</p>
  </GateSheet>
</Gate>
