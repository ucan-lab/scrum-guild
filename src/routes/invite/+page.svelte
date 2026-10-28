<script module lang="ts">
  // URL から読んだ秘密。この画面が作り直されても読めるよう、文書の間だけ持つ（onMount の説明）。ページを離れるときに消す
  let pendingToken = '';
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import Gate from '../../lib/components/Gate.svelte';
  import GateSheet from '../../lib/components/GateSheet.svelte';
  import GoogleMark from '../../lib/components/GoogleMark.svelte';
  import Icon from '../../lib/components/Icon.svelte';
  import { t } from '../../lib/vocabulary.svelte.ts';
  import { CLAIM_TOKEN_FIELD, CLAIM_TOKEN_PATTERN } from '../../shared/claim-token.ts';

  // 招待の URL（/invite#<秘密>）を開く画面（design/login.html の「Scrum Guild への招待」）。docs/data-model.md の
  // 「メールアドレスで待つ指名と招待」の 1 と 2。
  //   - 秘密は location.hash から読み、すぐ goto の replace で URL を /invite に置き換える（履歴、共有、Referer に残さない。
  //     フラグメントはサーバーに届かないので、読めるのはこの画面だけ）。このページのヘッダーは Referrer-Policy: no-referrer
  //   - 組織の名前は出さない（秘密を API に送る前なので、秘密を持つだけの人に組織の名前を見せない）
  //   - ボタンを押すまでログインを始めない。リンクを先読みする仕組み（メールの安全確認、チャットのプレビュー）で
  //     ログインが始まらないようにするため。押すと、隠し欄に秘密を入れたフォームを POST で送る（POST /api/auth/google/start）。
  //     すでにログインしていても、サーバーが Google のログインを通し、Google のアカウントのセッションに替える
  // 秘密は DOM に置かず、押すまでこの変数だけが持つ。押したときだけ隠し欄に入れ、ページを離れるときに消す（bfcache の復元で
  // DOM に残さない）。形が合わない（無い、短い、長い）URL は、ボタンを出さず使えない旨を出す
  let claimToken = '';
  // undefined: URL を読む前
  let usable = $state<boolean | undefined>(undefined);
  let form = $state<HTMLFormElement>();
  let field = $state<HTMLInputElement>();

  onMount(async () => {
    // 移動が SLOW_MS を超えると、root のレイアウトが読み込み中の表示に替えてこの画面を作り直す。作り直した画面は URL から
    // 秘密を読めないので、読んだ秘密は文書の間だけ module の変数に残す
    // 空のフラグメント（/invite#）は location.hash が '' になるので、# の有無は href で見る
    const hasFragment = (): boolean => location.href.includes('#');
    if (hasFragment()) pendingToken = location.hash.slice(1);
    const token = pendingToken;
    try {
      // 浅いルーティング（shallow）は、元の URL（秘密を含む）を履歴の項目の state に残すので使わない。同じ画面への移動で
      // 履歴の項目を置き換える。クエリは引き継がない（招待の URL はクエリを持たない）
      if (hasFragment()) await goto(resolve('/invite'), { replace: true });
    } finally {
      // ボタンは URL から秘密が消えてから出す。移動が失敗したか、ほかの移動に取って代わられて消えなければ、使えない旨を出す。
      // 移動の例外は catch しない（予期しない例外なので、画面のエラーの送り手 hooks.client.ts に未処理の reject として送る）
      usable = !hasFragment() && CLAIM_TOKEN_PATTERN.test(token);
      claimToken = usable ? token : '';
    }
  });

  // 同じ文書のままほかの画面へ移るときは、秘密を消す（戻った /invite で前の秘密を使わない）。URL を置き換える移動は
  // この画面への移動なので消さない（読み込み中の表示で作り直された画面が読む）
  beforeNavigate(({ to }) => {
    if (to?.route.id !== '/invite') pendingToken = '';
  });

  // 押した後は、Google へ移るまでの間の2回目以降の押下を無視する（2回送ると、state の行とレート制限の枠を2つ使う）
  let moving = $state(false);

  function start(): void {
    if (!usable || moving || form === undefined || field === undefined) return;
    moving = true;
    field.value = claimToken;
    form.submit();
  }

  // 戻るで bfcache から復元されたときは、ボタンを押せる状態に戻す
  function restore(event: PageTransitionEvent): void {
    if (event.persisted) moving = false;
  }

  // フォームの本文は送る時点で組まれているので、離れるときに隠し欄を空にしても送信には響かない
  function clearField(): void {
    if (field !== undefined) field.value = '';
    pendingToken = '';
  }
</script>

<svelte:window onpageshow={restore} onpagehide={clearField} />

<svelte:head>
  <title>{t('pageTitle', { page: t('inviteTitle', { app: t('appName') }), app: t('appName') })}</title>
</svelte:head>

<!-- 読み上げの領域。常に置き、文字だけを替える（後から挿入した領域は読み上げられないことがある） -->
<div class="visually-hidden" role="status">{moving ? t('inviteMoving') : ''}</div>
<!-- URL を読み終える前は、本文が空の紙を出さない -->
{#if usable !== undefined}
  <Gate>
    <GateSheet brand title={t('inviteTitle', { app: t('appName') })}>
      {#if usable === false}
        <div class="callout is-warn" role="alert"><Icon name="alert" /><span>{t('inviteUnusable')}</span></div>
      {:else}
        <p>{t('inviteLead')}</p>
        <!-- 画面の経路ではなく Worker への POST。秘密は URL ではなく本文で送る -->
        <form method="POST" action="/api/auth/google/start" bind:this={form} data-sveltekit-reload>
          <input type="hidden" name={CLAIM_TOKEN_FIELD} bind:this={field} />
        </form>
        <button class="btn is-wide is-google" type="button" aria-disabled={moving ? 'true' : undefined} onclick={start}
          ><GoogleMark />{moving ? t('inviteMoving') : t('loginWithGoogle')}</button
        >
        <p class="gate-note">{t('inviteNote')}</p>
      {/if}
    </GateSheet>
  </Gate>
{/if}
