<script lang="ts">
  import { onMount } from 'svelte';
  import Gate from '../../lib/components/Gate.svelte';
  import GateSheet from '../../lib/components/GateSheet.svelte';
  import GoogleMark from '../../lib/components/GoogleMark.svelte';
  import Icon from '../../lib/components/Icon.svelte';
  import { t } from '../../lib/vocabulary.svelte.ts';
  import { CLAIM_TOKEN_FIELD, CLAIM_TOKEN_PATTERN } from '../../shared/claim-token.ts';

  // 招待の URL（/invite#<秘密>）を開く画面（design/login.html の「Scrum Guild への招待」）。docs/data-model.md の
  // 「メールアドレスで待つ指名と招待」の 1 と 2。
  //   - 秘密は location.hash から読み、すぐ history.replaceState で URL を /invite に置き換える（履歴、共有、Referer に残さない。
  //     フラグメントはサーバーに届かないので、読めるのはこの画面だけ）。このページのヘッダーは Referrer-Policy: no-referrer
  //   - 組織の名前は出さない（秘密を API に送る前なので、秘密を持つだけの人に組織の名前を見せない）
  //   - ボタンを押すまでログインを始めない。リンクを先読みする仕組み（メールの安全確認、チャットのプレビュー）で
  //     ログインが始まらないようにするため。押すと、隠し欄に秘密を入れたフォームを POST で送る（POST /api/auth/google/start）。
  //     すでにログインしていても、サーバーが Google のログインを通し、Google のアカウントのセッションに替える
  // 秘密は DOM に置かず、押すまでこの変数だけが持つ。形が合わない（無い、短い、長い）URL は、ボタンを出さず使えない旨を出す
  let claimToken = '';
  // undefined: URL を読む前
  let usable = $state<boolean | undefined>(undefined);
  let form = $state<HTMLFormElement>();
  let field = $state<HTMLInputElement>();

  onMount(() => {
    const token = location.hash.slice(1);
    // history.state は SvelteKit のルーターが持つ値を残す。SvelteKit は開発のときに native の呼び出しに警告を出すが、
    // 履歴の位置は変えず URL だけを置き換えるので衝突しない
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
    usable = CLAIM_TOKEN_PATTERN.test(token);
    claimToken = usable ? token : '';
  });

  function start(): void {
    if (!usable || form === undefined || field === undefined) return;
    field.value = claimToken;
    form.submit();
  }
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('inviteTitle', { app: t('appName') }), app: t('appName') })}</title>
</svelte:head>

<Gate>
  <GateSheet brand title={t('inviteTitle', { app: t('appName') })}>
    {#if usable === false}
      <div class="callout is-warn" role="alert"><Icon name="alert" /><span>{t('loginErrorInvite')}</span></div>
    {:else if usable === true}
      <p>{t('inviteLead')}</p>
      <!-- 画面の経路ではなく Worker への POST。秘密は URL ではなく本文で送る -->
      <form method="POST" action="/api/auth/google/start" bind:this={form} data-sveltekit-reload>
        <input type="hidden" name={CLAIM_TOKEN_FIELD} bind:this={field} />
      </form>
      <button class="btn is-wide is-google" type="button" onclick={start}><GoogleMark />{t('loginWithGoogle')}</button>
      <p class="gate-note">{t('inviteNote')}</p>
    {/if}
  </GateSheet>
</Gate>
