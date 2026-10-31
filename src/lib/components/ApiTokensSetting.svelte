<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { page } from '$app/state';
  import type { OutputOf } from '../../shared/operations/define.ts';
  import { tokenCreate, tokenList, tokenRevoke } from '../../shared/operations/session/index.ts';
  import { API_TOKEN_NAME_MAX_LENGTH } from '../../shared/operations/session/token.ts';
  import {
    API_TOKEN_LIMIT_REASON,
    API_TOKEN_MAX_ACTIVE,
    API_TOKEN_MAX_LIFETIME_DAYS,
    type ApiTokenScope,
  } from '../../shared/api-token.ts';
  import { callOperation, type ApiResult } from '../api.ts';
  import { formatDateTime } from '../format-datetime.ts';
  import { formatLocalDate } from '../format.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import Dialog from './Dialog.svelte';
  import EmptyState from './EmptyState.svelte';
  import Icon from './Icon.svelte';
  import Setting from './Setting.svelte';

  // 自分の設定の画面の「API トークン」の節（見本は design/me.html）。CLI や MCP に渡す鍵を、自分で発行して取り消す。
  // - 発行: 名前、範囲（読み取り／書き込み）、有効日数（1〜90、既定 90）。通ったら、生の値をダイアログに出す。
  //   値は応答の本文にだけあり、ダイアログを閉じると画面からも消える（再び出す手段は無い）。Esc と背景では閉じず
  //   （うっかり閉じて値を失わないため）、「閉じる」と × だけで閉じる。開いた直後は値の欄でなく、
  //   「二度と見られません」の知らせへフォーカスを移す（先に読み上げる）。閉じたら、発行の欄へフォーカスを戻す。
  //   有効なトークンが上限（API_TOKEN_MAX_ACTIVE）に達していたら 409 が返り、取り消しを促す
  // - 一覧: 名前、範囲、期限、最後に使った日。値は出さない。各行の「取り消す」は確認のダイアログを経る（元に戻せない）。
  //   取り消せて一覧も読み直せたら、フォーカスを発行の欄へ移す（押した行が消えるため）。失敗したら、押したボタンに残す。
  //   取消の 404 は、ほかで取り消されたか期限が来て消えた行なので、取り消された扱いにして読み直す
  // - 一覧が読めなければ、この節にだけ失敗と「もう一度試す」を出す（画面のほかの節は生かす）。読み直せたら節の題へフォーカスを移す。
  //   読み直しの失敗は、今の一覧を残して知らせる
  // 操作は1件ずつ送り、送っている間はどの操作も aria-disabled にして押しても無視する
  type Token = OutputOf<typeof tokenList>['tokens'][number];
  type FieldName = 'name' | 'lifetime';
  type RetryState = 'idle' | 'retrying' | 'failed';
  // stale は、待つ間に新しい読み込みが始まったので、この応答を捨てたこと
  type ReloadOutcome = 'ok' | 'failed' | 'stale';

  // initial は画面の load が読んだ一覧。読めなかったときは null
  let { initial }: { initial: Token[] | null } = $props();

  const ids = $props.id();
  const nameId = `${ids}-name`;
  const nameHintId = `${ids}-name-hint`;
  const nameErrorId = `${ids}-name-error`;
  const scopeLabelId = `${ids}-scope-label`;
  const scopeHintId = `${ids}-scope-hint`;
  const lifetimeId = `${ids}-lifetime`;
  const lifetimeHintId = `${ids}-lifetime-hint`;
  const lifetimeErrorId = `${ids}-lifetime-error`;

  let tokens = $state<Token[] | null>(untrack(() => initial));
  // 一覧を読み直せなかった（今の一覧は残す）
  let refreshFailed = $state(false);
  let retry = $state<RetryState>('idle');
  // 古い応答を捨てるための番号。一覧を読むたびと、画面の load が替わったときに進める（リアクティブにしない）
  let loadSeq = 0;
  $effect.pre(() => {
    const next = initial;
    untrack(() => {
      tokens = next;
      refreshFailed = false;
      retry = 'idle';
      loadSeq++;
    });
  });

  let name = $state('');
  let scope = $state<ApiTokenScope>('read');
  let lifetime = $state<number | null>(API_TOKEN_MAX_LIFETIME_DAYS);
  let fieldError = $state<{ field: FieldName | 'form'; text: string } | null>(null);
  let busy = $state<'create' | 'revoke' | null>(null);
  // 読み上げの領域に入れる文（発行中、取消中、読み直せた）
  let status = $state('');

  let setting = $state<ReturnType<typeof Setting>>();
  let nameInput = $state<HTMLInputElement>();
  let lifetimeInput = $state<HTMLInputElement>();
  let formError = $state<HTMLElement>();

  // 発行した直後だけ持つ生の値。ダイアログを閉じると捨てる
  let issued = $state<{ name: string; token: string; expiresAt: string } | null>(null);
  let issuedDialog = $state<ReturnType<typeof Dialog>>();
  let issuedOpen = $state(false);
  let issuedLead = $state<HTMLElement>();
  let valueInput = $state<HTMLInputElement>();

  let revokeDialog = $state<ReturnType<typeof ConfirmDialog>>();
  let revokeTarget = $state<Token | null>(null);

  function toLogin(result: Parameters<typeof loginUrl>[1]): void {
    window.location.assign(loginUrl(page.url, result));
  }

  async function reload(): Promise<ReloadOutcome> {
    const mine = ++loadSeq;
    const result = await callOperation(tokenList, {});
    if (mine !== loadSeq) return 'stale';
    if (!result.ok && isUnauthenticated(result)) {
      toLogin(result);
      return 'failed';
    }
    if (!result.ok) {
      if (tokens !== null) refreshFailed = true;
      return 'failed';
    }
    tokens = result.data.tokens;
    refreshFailed = false;
    return 'ok';
  }

  async function retryLoad(): Promise<void> {
    if (retry === 'retrying') return;
    retry = 'retrying';
    const outcome = await reload();
    // 捨てた応答は失敗ではない。新しい読み込みが、この節の表示を決める
    retry = outcome === 'failed' ? 'failed' : 'idle';
    if (outcome !== 'ok') return;
    // 押したボタンが消えるので、節の題へフォーカスを移し、読めたことを読み上げに伝える
    status = t('apiTokenLoaded');
    await tick();
    setting?.focusTitle();
  }

  // 入力欄の誤り。送る前に画面で見つけて、その欄へフォーカスを移す（API は同じ範囲で 400 を返す）
  function problem(): { field: FieldName; text: string } | null {
    const trimmed = name.trim();
    if (trimmed.length === 0) return { field: 'name', text: t('apiTokenNameRequired') };
    // API と DB は文字数（コードポイント）で数える。length は UTF-16 の単位なので、絵文字が多い名前を誤って断る
    if ([...trimmed].length > API_TOKEN_NAME_MAX_LENGTH) {
      return { field: 'name', text: t('apiTokenNameTooLong', { max: String(API_TOKEN_NAME_MAX_LENGTH) }) };
    }
    if (lifetime === null || !Number.isInteger(lifetime) || lifetime < 1 || lifetime > API_TOKEN_MAX_LIFETIME_DAYS) {
      return { field: 'lifetime', text: t('apiTokenLifetimeInvalid', { max: String(API_TOKEN_MAX_LIFETIME_DAYS) }) };
    }
    return null;
  }

  // 発行の上限に達した 409（details.reason が limit）
  function isLimitReached(result: Exclude<ApiResult<unknown>, { ok: true }>): boolean {
    const details = result.error?.details;
    return (
      result.status === 409 &&
      result.error?.code === 'conflict' &&
      typeof details === 'object' &&
      details !== null &&
      'reason' in details &&
      details.reason === API_TOKEN_LIMIT_REASON
    );
  }

  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy !== null) return;
    const found = problem();
    if (found !== null) {
      fieldError = found;
      (found.field === 'name' ? nameInput : lifetimeInput)?.focus();
      return;
    }
    fieldError = null;
    busy = 'create';
    status = t('apiTokenCreating');
    try {
      const result = await callOperation(tokenCreate, {
        name: name.trim(),
        scope,
        // 90日は省略と同じ。API の既定に任せず、画面に見えている値をそのまま送る
        lifetime_days: lifetime ?? API_TOKEN_MAX_LIFETIME_DAYS,
      });
      if (result.ok) {
        issued = { name: result.data.name, token: result.data.token, expiresAt: result.data.expires_at };
        name = '';
        scope = 'read';
        lifetime = API_TOKEN_MAX_LIFETIME_DAYS;
        status = '';
        // 開いたら、値の欄でなく本文へフォーカスを移す。「二度と見られません」まで続けて読めるように
        issuedDialog?.show(nameInput);
        await tick();
        issuedLead?.focus();
        void reload();
        return;
      }
      if (isUnauthenticated(result)) {
        toLogin(result);
        return;
      }
      // 400 は画面の検査を通った後なので、理由を決めつけず、ほかの失敗と同じ文にする。
      // 応答が届かなかっただけで、サーバーでは作れていることがあるので、一覧は読み直す
      const text = isLimitReached(result)
        ? t('apiTokenLimitReached', { max: String(API_TOKEN_MAX_ACTIVE) })
        : t('apiTokenCreateFailed');
      fieldError = { field: 'form', text };
      void reload();
      await tick();
      formError?.focus();
    } finally {
      busy = null;
      status = '';
    }
  }

  // ダイアログを閉じたら、生の値を捨てる
  $effect(() => {
    if (issuedOpen || issued === null) return;
    issued = null;
  });

  async function copy(): Promise<void> {
    if (issued === null) return;
    try {
      await navigator.clipboard.writeText(issued.token);
      showToast(t('apiTokenCopied'), 'check');
    } catch {
      valueInput?.select();
      showToast(t('apiTokenCopyFailed'), 'alert');
    }
  }

  async function revoke(token: Token, trigger: HTMLElement): Promise<void> {
    if (busy !== null) return;
    revokeTarget = token;
    if (!((await revokeDialog?.ask(trigger)) ?? false)) return;
    busy = 'revoke';
    status = t('apiTokenRevoking');
    let rowGone: boolean;
    try {
      const result = await callOperation(tokenRevoke, { id: token.id });
      if (!result.ok && isUnauthenticated(result)) {
        toLogin(result);
        return;
      }
      // 404 は、ほかで取り消したか期限が来て消えた行。取り消された扱いにして、読み直して行を消す
      const revoked = result.ok || result.status === 404;
      if (revoked) showToast(t('apiTokenRevoked', { name: token.name }), 'check');
      else showToast(t('apiTokenRevokeFailed'), 'alert');
      // 上限の知らせは「取り消してください」と促すので、取り消せたら消す（発行の入力の誤りは、その欄を直すまで残す）
      if (revoked && fieldError?.field === 'form') fieldError = null;
      // 取り消せなかったときも、行の今の状態に合わせるために読み直す
      rowGone = revoked && (await reload()) === 'ok';
    } finally {
      busy = null;
      status = '';
    }
    // 押した行が一覧から消えたときだけ、発行の欄へフォーカスを移す。残ったときは、確認のダイアログが戻した押したボタンのまま
    if (!rowGone) return;
    await tick();
    nameInput?.focus();
  }

  const scopeLabel = (value: ApiTokenScope): string => t(value === 'read' ? 'apiTokenScopeRead' : 'apiTokenScopeWrite');
  const describedBy = (...ids: (string | null)[]): string => ids.filter((id) => id !== null).join(' ');
</script>

{#snippet retryActions()}
  <button
    class="btn is-sm"
    type="button"
    aria-label={t('retrySection', { section: t('apiTokenTitle') })}
    aria-disabled={retry === 'retrying'}
    onclick={retryLoad}>{t('retry')}</button
  >
  <span class="field-hint" role="status"
    >{retry === 'retrying' ? t('retrying') : retry === 'failed' ? t('retryFailed') : ''}</span
  >
{/snippet}

<Setting bind:this={setting} title={t('apiTokenTitle')} description={t('apiTokenDesc')}>
  <form class="form" aria-label={t('apiTokenFormLabel')} onsubmit={create} novalidate>
    <div class="form-row is-start">
      <div class="field" class:is-invalid={fieldError?.field === 'name'}>
        <label class="field-label" for={nameId}>{t('apiTokenNameLabel')}</label>
        <input
          class="input"
          id={nameId}
          bind:this={nameInput}
          bind:value={name}
          autocomplete="off"
          readonly={busy === 'create'}
          aria-invalid={fieldError?.field === 'name'}
          aria-describedby={describedBy(nameHintId, fieldError?.field === 'name' ? nameErrorId : null)}
          oninput={() => (fieldError = fieldError?.field === 'name' ? null : fieldError)}
        />
        <span class="field-hint" id={nameHintId}
          >{t('apiTokenNameHint', { max: String(API_TOKEN_NAME_MAX_LENGTH) })}</span
        >
        {#if fieldError?.field === 'name'}
          <span class="field-error" id={nameErrorId} role="alert"><Icon name="alert" />{fieldError.text}</span>
        {/if}
      </div>
      <div class="field">
        <span class="field-label" id={scopeLabelId}>{t('apiTokenScopeLabel')}</span>
        <!-- 送っている間は disabled でなく aria-disabled にして、押しても選びを変えない（フォーカスを失わせないため） -->
        <div class="segmented" role="radiogroup" aria-labelledby={scopeLabelId} aria-describedby={scopeHintId}>
          <label>
            <input
              type="radio"
              name={`${ids}-scope`}
              value="read"
              bind:group={scope}
              aria-disabled={busy === 'create'}
              onclick={(event) => busy === 'create' && event.preventDefault()}
            />
            <span>{t('apiTokenScopeRead')}</span>
          </label>
          <label>
            <input
              type="radio"
              name={`${ids}-scope`}
              value="write"
              bind:group={scope}
              aria-disabled={busy === 'create'}
              onclick={(event) => busy === 'create' && event.preventDefault()}
            />
            <span>{t('apiTokenScopeWrite')}</span>
          </label>
        </div>
        <span class="field-hint" id={scopeHintId}>{t('apiTokenScopeHint')}</span>
      </div>
      <div class="field" class:is-invalid={fieldError?.field === 'lifetime'}>
        <label class="field-label" for={lifetimeId}>{t('apiTokenLifetimeLabel')}</label>
        <input
          class="input"
          id={lifetimeId}
          type="number"
          inputmode="numeric"
          min="1"
          max={API_TOKEN_MAX_LIFETIME_DAYS}
          step="1"
          bind:this={lifetimeInput}
          bind:value={lifetime}
          readonly={busy === 'create'}
          aria-invalid={fieldError?.field === 'lifetime'}
          aria-describedby={describedBy(lifetimeHintId, fieldError?.field === 'lifetime' ? lifetimeErrorId : null)}
          oninput={() => (fieldError = fieldError?.field === 'lifetime' ? null : fieldError)}
        />
        <span class="field-hint" id={lifetimeHintId}
          >{t('apiTokenLifetimeHint', { max: String(API_TOKEN_MAX_LIFETIME_DAYS) })}</span
        >
        {#if fieldError?.field === 'lifetime'}
          <span class="field-error" id={lifetimeErrorId} role="alert"><Icon name="alert" />{fieldError.text}</span>
        {/if}
      </div>
    </div>
    {#if fieldError?.field === 'form'}
      <div class="callout is-danger" role="alert" tabindex="-1" bind:this={formError}>
        <Icon name="alert" /><span>{fieldError.text}</span>
      </div>
    {/if}
    <div class="form-actions">
      <button class="btn is-primary" type="submit" aria-disabled={busy !== null}>
        {busy === 'create' ? t('apiTokenCreating') : t('apiTokenCreate')}
      </button>
    </div>
  </form>
  <!-- 発行中、取消中、読み直せたことの読み上げ。領域は常に置き、中の文字だけを替える（見える所には出さない） -->
  <span class="visually-hidden" role="status">{status}</span>

  {#if tokens === null}
    <EmptyState icon="alert" title={t('apiTokenLoadFailed')} text={t('loadFailedText')} actions={retryActions} />
  {:else}
    {#if refreshFailed}
      <div class="callout is-warn">
        <Icon name="alert" /><span role="alert">{t('apiTokenLoadFailed')}</span>
        <div class="callout-actions">{@render retryActions()}</div>
      </div>
    {/if}
    {#if tokens.length === 0}
      <EmptyState icon="lock" title={t('apiTokenEmptyTitle')} text={t('apiTokenEmptyText')} />
    {:else}
      <div class="table-wrap">
        <!-- 行の操作（取り消す）を持つので、狭い幅で1行を縦に積む（is-stacked） -->
        <table class="table is-stacked" aria-label={t('apiTokenListLabel')}>
          <thead>
            <tr>
              <th class="is-name">{t('apiTokenNameLabel')}</th>
              <th>{t('apiTokenScopeLabel')}</th>
              <th>{t('apiTokenHeaderExpires')}</th>
              <th>{t('apiTokenHeaderLastUsed')}</th>
              <th class="is-actions"><span class="visually-hidden">{t('apiTokenActionsHeader')}</span></th>
            </tr>
          </thead>
          <tbody>
            {#each tokens as token (token.id)}
              <tr>
                <td class="is-name wrap-anywhere" data-label={t('apiTokenNameLabel')}>{token.name}</td>
                <td data-label={t('apiTokenScopeLabel')}><span class="tag">{scopeLabel(token.scope)}</span></td>
                <td class="mono" data-label={t('apiTokenHeaderExpires')}>{formatLocalDate(token.expires_at)}</td>
                <!-- 日付だけ等幅にする。「未使用」は文なので等幅にしない -->
                <td class:mono={token.last_used_at !== null} data-label={t('apiTokenHeaderLastUsed')}>
                  {token.last_used_at === null ? t('apiTokenNeverUsed') : formatLocalDate(token.last_used_at)}
                </td>
                <td class="is-actions">
                  <button
                    class="btn is-sm is-quiet is-danger"
                    type="button"
                    aria-disabled={busy !== null}
                    aria-label={t('apiTokenRevokeLabel', { name: token.name })}
                    onclick={(event) => void revoke(token, event.currentTarget)}>{t('apiTokenRevoke')}</button
                  >
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</Setting>

<Dialog bind:this={issuedDialog} bind:open={issuedOpen} outsideDismiss={false} title={t('apiTokenIssuedTitle')}>
  {#if issued}
    <p tabindex="-1" bind:this={issuedLead}>{t('apiTokenIssuedLead', { name: issued.name })}</p>
    <div class="field">
      <label class="field-label" for={`${ids}-value`}>{t('apiTokenValueLabel')}</label>
      <div class="input-row">
        <input
          class="input mono"
          id={`${ids}-value`}
          value={issued.token}
          readonly
          autocomplete="off"
          spellcheck="false"
          bind:this={valueInput}
        />
        <button class="btn" type="button" onclick={copy}><Icon name="link" />{t('apiTokenCopy')}</button>
      </div>
    </div>
    <div class="callout is-warn">
      <Icon name="alert" /><span>{t('apiTokenOnce')}</span>
    </div>
    <p class="field-hint">{t('apiTokenIssuedExpires', { expires: formatDateTime(issued.expiresAt) })}</p>
  {/if}
  {#snippet footer(close)}
    <button class="btn is-primary" type="button" onclick={close}>{t('close')}</button>
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:this={revokeDialog}
  title={t('apiTokenRevokeTitle', { name: revokeTarget?.name ?? '' })}
  confirmLabel={t('apiTokenRevoke')}
  cancelLabel={t('cancel')}
  danger
>
  <p>{t('apiTokenRevokeText')}</p>
</ConfirmDialog>
