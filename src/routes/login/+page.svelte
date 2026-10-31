<script lang="ts">
  import { page } from '$app/state';
  import Gate from '../../lib/components/Gate.svelte';
  import GateSheet from '../../lib/components/GateSheet.svelte';
  import GoogleMark from '../../lib/components/GoogleMark.svelte';
  import Icon from '../../lib/components/Icon.svelte';
  import LegalLinks from '../../lib/components/LegalLinks.svelte';
  import { submitPasswordLogin } from '../../lib/password-login.ts';
  import { t } from '../../lib/vocabulary.svelte.ts';
  import { PASSWORD_LOGIN_ENABLED } from '../../shared/password-login-enabled.ts';
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
    invite: 'loginErrorInvite',
  };

  const returnTo = $derived(safeReturnTo(page.url.searchParams.get('return_to')));
  const githubStartHref = $derived(`/api/auth/github/start?return_to=${encodeURIComponent(returnTo)}`);
  const googleStartHref = $derived(`/api/auth/google/start?return_to=${encodeURIComponent(returnTo)}`);
  // 自分のキーだけで引く（constructor や __proto__ のような継承したキーで、辞書に無い値を引かない）
  const errorKey = $derived.by(() => {
    const error = page.url.searchParams.get('error') ?? '';
    return Object.hasOwn(errorMessages, error) ? errorMessages[error] : undefined;
  });

  // ログアウトの直後（src/lib/logout-action.svelte.ts が付ける）。?error= があるときは、エラーだけを出す。
  // 読み込んだときから在る文なので role="status" を付けない（読み上げの領域は、常に置いて文字だけを替えるときに使う）。見出しの次に読まれる
  const loggedOut = $derived(page.url.searchParams.get('logged_out') === '1' && !page.url.searchParams.has('error'));

  // ほかの文言に混ぜる言葉。organization と workspace と leader は辞書のそれぞれの項目
  const words = $derived({ organization: t('organization'), workspace: t('workspace'), leader: t('leader') });

  // メールアドレスとパスワードでのログイン（src/lib/password-login.ts）。画面を移らずに送り、成功したら戻る先へ移る。
  // 断られたら理由をフォームの中、ボタンの上に出し（押したボタンの近くに出す。狭い幅で見出しの下は画面の外になる）、
  // 欄に aria-describedby で結ぶ。メールアドレスは残してパスワードだけを空にする。
  // 送っている間はボタンを押せなくする（フォーカスを残すため disabled ではなく aria-disabled にし、送信の側で止める）。
  // 前の理由は送っている間も残し（消すと画面が上下に動く）、応答が来たら置き換える。同じ理由でも出し直して読み上げる
  let email = $state('');
  let password = $state('');
  let submitting = $state(false);
  let formError = $state<DictionaryKey | undefined>(undefined);
  let attempts = $state(0);
  const formErrorId = 'login-form-error';

  async function submitPassword(event: SubmitEvent) {
    event.preventDefault();
    if (submitting) return;
    // 空の欄は送らない（回数の上限を使わず、何が足りないかを伝える）。形の検査は API に任せる
    if (email.trim() === '' || password === '') {
      formError = 'loginErrorEmptyFields';
      attempts += 1;
      return;
    }
    submitting = true;
    const outcome = await submitPasswordLogin({ email, password, returnTo });
    if (outcome.ok) {
      // ページごと読み直す（ほかの手段のログインと同じく、ログイン後の画面を初めから読み込む）。
      // replace にして、ログインの画面を履歴に残さない（戻るでログインの画面に戻らない）。移った先で submitting は戻さない
      location.replace(outcome.returnTo);
      return;
    }
    password = '';
    formError = outcome.message;
    attempts += 1;
    submitting = false;
  }
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('loginTitle'), app: t('appName') })}</title>
</svelte:head>

<Gate>
  <GateSheet brand title={t('loginTitle')}>
    <!-- ほかの手段の ?error= の理由。パスワードで断られた後は、フォームの中の理由だけを出す -->
    {#if errorKey && !formError}
      <div class="callout is-warn" role="alert"><Icon name="alert" /><span>{t(errorKey, words)}</span></div>
    {:else if loggedOut && !formError}
      <div class="callout is-info"><Icon name="shield" /><span>{t('loggedOut')}</span></div>
    {/if}
    <p>{t('loginLead', words)}</p>
    <!-- 画面の経路ではなく Worker の GET。resolve() は経路の ID を要るので通さず、data-sveltekit-reload で直に開く -->
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
    <a class="btn is-wide" href={githubStartHref} data-sveltekit-reload><Icon name="git" />{t('loginWithGithub')}</a>
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
    <a class="btn is-wide is-google" href={googleStartHref} data-sveltekit-reload
      ><GoogleMark />{t('loginWithGoogle')}</a
    >
    <!-- 閉じている間（PASSWORD_LOGIN_ENABLED が偽）は、区切りもフォームも出さない。API の口も閉じている（src/server/app.ts） -->
    {#if PASSWORD_LOGIN_ENABLED}
      <p class="gate-divider">{t('loginDivider')}</p>
      <!-- method="post": 万一ブラウザの送信が走っても、パスワードを URL に載せない -->
      <form class="form-fields" method="post" novalidate onsubmit={submitPassword}>
        <div class="field">
          <label class="field-label" for="login-email">{t('loginEmailLabel')}</label>
          <input
            class="input"
            id="login-email"
            name="email"
            type="email"
            autocomplete="email"
            spellcheck="false"
            aria-describedby={formError ? formErrorId : undefined}
            bind:value={email}
          />
        </div>
        <div class="field">
          <label class="field-label" for="login-password">{t('loginPasswordLabel')}</label>
          <input
            class="input"
            id="login-password"
            name="password"
            type="password"
            autocomplete="current-password"
            aria-describedby={formError ? formErrorId : undefined}
            bind:value={password}
          />
        </div>
        {#if formError}
          {#key attempts}
            <div class="callout is-warn" id={formErrorId} role="alert">
              <Icon name="alert" /><span>{t(formError, words)}</span>
            </div>
          {/key}
        {/if}
        <button class="btn is-primary is-wide" type="submit" aria-disabled={submitting}>
          {submitting ? t('loginWithPasswordMoving') : t('loginWithPassword')}
        </button>
      </form>
    {/if}
    <p class="gate-note">{t('loginNote', words)}</p>
    <LegalLinks />
  </GateSheet>
</Gate>
