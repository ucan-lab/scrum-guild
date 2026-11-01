<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import Gate from '../../lib/components/Gate.svelte';
  import GateSheet from '../../lib/components/GateSheet.svelte';
  import GoogleMark from '../../lib/components/GoogleMark.svelte';
  import Icon from '../../lib/components/Icon.svelte';
  import LegalLinks from '../../lib/components/LegalLinks.svelte';
  import { t } from '../../lib/vocabulary.svelte.ts';
  import { safeReturnTo } from '../../shared/return-to.ts';

  // 会員登録の画面（枠の外）。招待の無い人が GitHub か Google でアカウントを作る。パスワードの欄は無い。
  // ログインの画面と同じく、開始は GET のリダイレクトなので、ボタンはリンクにして画面の遷移を通さず直に開く。
  // 開始の URL に signup=1 を付けると、サーバーが往復に登録の印を付ける（src/server/auth/login-routes.ts）。
  // 登録後に戻る先は return_to（自分のサイトのパス。無いか不正なら /）。
  // 往復の失敗（?error=）はサーバーがログインの画面へ戻すので、この画面は error を出さない
  const returnTo = $derived(safeReturnTo(page.url.searchParams.get('return_to')));
  const startQuery = $derived(`signup=1&return_to=${encodeURIComponent(returnTo)}`);
  const githubStartHref = $derived(`/api/auth/github/start?${startQuery}`);
  const googleStartHref = $derived(`/api/auth/google/start?${startQuery}`);
  // ログインの画面へ戻る。戻り先が `/` でなければ引き継ぐ
  const loginQuery = $derived(returnTo === '/' ? '' : `?return_to=${encodeURIComponent(returnTo)}`);

  // ほかの文言に混ぜる言葉。organization は辞書の項目
  const words = $derived({ organization: t('organization') });
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('signupTitle'), app: t('appName') })}</title>
</svelte:head>

<Gate>
  <GateSheet brand title={t('signupTitle')}>
    <p>{t('signupLead', words)}</p>
    <!-- 画面の経路ではなく Worker の GET。resolve() は経路の ID を要るので通さず、data-sveltekit-reload で直に開く -->
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
    <a class="btn is-wide" href={githubStartHref} data-sveltekit-reload><Icon name="git" />{t('signupWithGithub')}</a>
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
    <a class="btn is-wide is-google" href={googleStartHref} data-sveltekit-reload
      ><GoogleMark />{t('signupWithGoogle')}</a
    >
    <p class="gate-note">{t('signupNote', words)}</p>
    <div class="form-actions">
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- 経路は resolve() で解決し、引き継ぐ return_to のクエリだけを足している -->
      <a class="btn is-sm is-quiet" href={`${resolve('/login')}${loginQuery}`}>{t('signupLoginLink')}</a>
    </div>
    <LegalLinks />
  </GateSheet>
</Gate>
