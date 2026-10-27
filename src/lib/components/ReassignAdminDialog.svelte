<script lang="ts">
  import { tick } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { callOperation, type ApiResult } from '../api.ts';
  import { formatDateTime } from '../format-datetime.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import { EMAIL_MAX_LENGTH } from '../../shared/email.ts';
  import {
    GITHUB_USERNAME_MAX_LENGTH,
    organizationAdminReassign,
    resolveGithubUser,
    type AdminStatus,
  } from '../../shared/operations/operator/index.ts';
  import type { DictionaryKey } from '../../shared/vocabulary.ts';
  import Avatar from './Avatar.svelte';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // design/kit.js の reassignAdmin。運用者が既にある組織に管理者を指名し直すダイアログ（organization-admin-reassign）。
  // 指し方は組織の作成の最初の管理者と同じ（CreateOrganizationDialog.svelte）。ログインの手段を選び、GitHub はユーザー名を
  // resolve-github-user で解決して指名する人（アバター、ユーザー名、表示名）を見て確かめるまで指名できない。送るときは確かめた
  // ユーザー ID を渡し、サーバーが解決し直して違えば断る。Google はメールアドレスで指す（確かめる手順は無い）。
  // 最初の文は、開いたときの一覧の管理者の状態（none、pending、expired、active）で変える。
  // 指名した後は、同じダイアログを完了の表示に切り替える。GitHub は組織の URL と「GitHub の <名前> でログインするよう伝えて
  // ください」、Google は招待の URL（コピーできる）と期限。招待の URL は応答の本文にだけあり、この画面の状態（done）が閉じるときに捨てる。
  // 指名した後に閉じたら、一覧を読み直して管理者の状態を変える。書かれたか分からない失敗（409、5xx、通信の切れ）の後も読み直す。
  //
  // 応答が遅れて届いても、古い入力の結果で今の状態を書き換えない（作成のダイアログと同じ世代の数え方）。
  // 送っている間は、入力欄と手段を読み取り専用にし、閉じる操作を無視する
  type Target = { slug: string; name: string; admin_status: AdminStatus };
  type Resolved = {
    username: string;
    loginSubject: string;
    loginName: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  type Done =
    | { kind: 'named'; slug: string; loginName: string }
    | { kind: 'invite'; email: string; inviteUrl: string; expiresAt: string };
  type Field = 'username' | 'email' | 'form';
  type FailedResult = Extract<ApiResult<unknown>, { ok: false }>;

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let target = $state<Target | null>(null);
  let via = $state<'github' | 'google'>('github');
  let username = $state('');
  let email = $state('');
  let resolved = $state<Resolved | null>(null);
  let done = $state<Done | null>(null);
  let busy = $state<'idle' | 'resolving' | 'sending'>('idle');
  let errors = $state<Partial<Record<Field, DictionaryKey>>>({});
  let doneLead = $state<HTMLElement>();
  let urlInput = $state<HTMLInputElement>();
  let formCallout = $state<HTMLElement>();
  let dialogEpoch = 0;
  let inputEpoch = 0;
  // 指名した後に閉じたら、一覧を読み直す
  let reloadOnClose = false;

  const ids = $props.id();
  const fieldIds = { username: `${ids}-username`, email: `${ids}-email` } as const;
  const viaLabelId = `${ids}-via`;
  const words = $derived({ organization: t('organization'), admin: t('admin') });
  const github = $derived(via === 'github');
  const sending = $derived(busy === 'sending');
  const organizationUrl = $derived(done?.kind === 'named' ? `${page.url.origin}/${done.slug}/` : '');
  const usernameDescribedBy = $derived(
    errors.username ? `${ids}-username-error ${ids}-username-hint` : `${ids}-username-hint`,
  );
  const emailDescribedBy = $derived(errors.email ? `${ids}-email-error ${ids}-email-hint` : `${ids}-email-hint`);
  // 「指名する」を押せるか。GitHub は確かめた後、Google はメールアドレスを入れた後
  const ready = $derived(github ? resolved !== null : email.trim() !== '');
  const leadKeys: Record<AdminStatus, DictionaryKey> = {
    none: 'operatorReassignLeadNone',
    pending: 'operatorReassignLeadPending',
    expired: 'operatorReassignLeadExpired',
    active: 'operatorReassignLeadActive',
  };
  // 読み上げの領域の文字。領域は常に置き、文字だけを替える
  const live = $derived(
    done !== null
      ? t('operatorLiveReassigned')
      : busy === 'sending'
        ? t('operatorLiveReassigning')
        : busy === 'resolving'
          ? t('operatorLiveVerifying')
          : resolved !== null
            ? t('operatorLiveVerified', { name: resolved.loginName })
            : '',
  );

  export function show(organization: Target, trigger?: HTMLElement | null): void {
    reset();
    target = organization;
    dialog?.show(trigger);
  }

  // 開くときと閉じるときに入力を捨てる。世代を進めるので、閉じる前に送った要求の応答は、開き直した後の状態に入らない
  function reset(): void {
    dialogEpoch++;
    inputEpoch++;
    via = 'github';
    username = '';
    email = '';
    resolved = null;
    done = null;
    busy = 'idle';
    errors = {};
  }

  $effect(() => {
    if (open) return;
    reset();
    if (reloadOnClose) {
      reloadOnClose = false;
      void invalidateAll();
    }
  });

  // 完了の表示に切り替わったら、フォーカスを消えたボタンから本文に移す（読み上げが続きを読める）
  $effect(() => {
    if (done !== null) doneLead?.focus();
  });

  // 入力の誤りの理由（details の code）を、辞書のキーに写す（組織の作成と同じ理由と文言）
  const problemKeys: Record<string, DictionaryKey> = {
    github_user_not_found: 'operatorErrorUserNotFound',
    github_not_a_user: 'operatorErrorNotUser',
    github_user_changed: 'operatorErrorUserChanged',
    email_invalid: 'operatorErrorEmailInvalid',
    // 指名し直しだけの理由。GitHub で解決した人が、操作する運用者自身だった
    nominee_is_operator: 'operatorErrorNomineeIsOperator',
  };

  function problemCodesOf(result: FailedResult): string[] {
    const details = result.error?.details;
    if (!Array.isArray(details)) return [];
    return details.flatMap((item: unknown) =>
      typeof item === 'object' && item !== null && 'code' in item && typeof item.code === 'string' ? [item.code] : [],
    );
  }

  type Failure = { field: Field; key: DictionaryKey; code?: string };

  // 失敗を、どの欄にどの文言を出すかに写す。ログインが切れた、運用者でなくなった人は、画面ごと移し、undefined を返す
  // （欄の誤りもフォーカスの移動もしない）。context は、ユーザー名を確かめる（verify）か、指名する（send）か
  function failureOf(result: FailedResult, context: 'verify' | 'send'): Failure | undefined {
    if (isUnauthenticated(result)) {
      window.location.assign(loginUrl(page.url));
      return undefined;
    }
    if (result.status === 403) {
      window.location.assign('/');
      return undefined;
    }
    const code = problemCodesOf(result).find((item) => Object.hasOwn(problemKeys, item));
    if (code !== undefined) {
      return { field: code === 'email_invalid' ? 'email' : 'username', key: problemKeys[code]!, code };
    }
    const field: Field = context === 'verify' ? 'username' : 'form';
    if (result.status === 400) return { field, key: 'operatorErrorInvalid' };
    // GitHub に届かないのは、書く前（解決の段）。何も書かれていない
    if (result.status === 503 && result.error?.code === 'unavailable') {
      return { field, key: 'operatorErrorGithubUnavailable' };
    }
    if (context === 'verify') {
      return { field, key: result.status === 0 ? 'operatorErrorUnreachable' : 'operatorErrorVerifyFailed' };
    }
    if (result.status === 404 && result.error?.code === 'not_found') return { field, key: 'operatorReassignNotFound' };
    if (result.status === 409 && result.error?.code === 'conflict') return { field, key: 'operatorReassignConflict' };
    return { field, key: 'operatorReassignFailed' };
  }

  // 失敗した欄へフォーカスを移す。欄に紐づかない失敗は、誤りを出した枠（callout）へ移す
  async function focusFailure(field: Field): Promise<void> {
    await tick();
    if (field === 'form') formCallout?.focus();
    else document.getElementById(fieldIds[field])?.focus();
  }

  // 手段を替えたら、確かめた結果と誤りは捨てる
  function changeVia(): void {
    inputEpoch++;
    resolved = null;
    if (busy === 'resolving') busy = 'idle';
    errors = {};
  }

  function changeEmail(): void {
    errors = { ...errors, email: undefined, form: undefined };
  }

  // ユーザー名を直したら、確かめた結果は捨てる（確かめた人と違う人を指名しないため）。確かめている最中の応答も捨てる
  function changeUsername(): void {
    inputEpoch++;
    resolved = null;
    if (busy === 'resolving') busy = 'idle';
    errors = { ...errors, username: undefined, form: undefined };
  }

  async function verify(): Promise<void> {
    if (busy !== 'idle' || !github) return;
    const value = username.trim();
    if (value === '') {
      errors = { ...errors, username: 'operatorErrorUserRequired' };
      await focusFailure('username');
      return;
    }
    resolved = null;
    errors = { ...errors, username: undefined, form: undefined };
    busy = 'resolving';
    const epochs = { dialog: dialogEpoch, input: inputEpoch };
    const result = await callOperation(resolveGithubUser, { username: value });
    if (epochs.dialog !== dialogEpoch || epochs.input !== inputEpoch) return;
    busy = 'idle';
    if (result.ok) {
      resolved = {
        username: value,
        loginSubject: result.data.login_subject,
        loginName: result.data.login_name,
        displayName: result.data.display_name,
        avatarUrl: result.data.avatar_url,
      };
      return;
    }
    const failure = failureOf(result, 'verify');
    if (failure === undefined) return;
    errors = { ...errors, [failure.field]: failure.key };
    await focusFailure(failure.field);
  }

  type AdminToSend =
    { provider: 'google'; email: string } | { provider: 'github'; username: string; login_subject: string };

  // 送る人。GitHub は確かめた人（確かめていなければ送らない）、Google は入れたメールアドレス。送れないときは undefined
  function adminToSend(): AdminToSend | undefined {
    if (!github) {
      const value = email.trim();
      if (value === '') {
        errors = { ...errors, email: 'operatorErrorEmailRequired' };
        return undefined;
      }
      return { provider: 'google', email: value };
    }
    if (resolved === null) return undefined;
    if (username.trim() !== resolved.username) {
      resolved = null;
      errors = { ...errors, username: 'operatorErrorVerifyAgain' };
      return undefined;
    }
    return { provider: 'github', username: resolved.username, login_subject: resolved.loginSubject };
  }

  // 書かれたか分からない失敗: 409（同じ人の行が変わった）、5xx（GitHub に届かない 503 は書く前なので除く）、通信の切れ
  function mayHaveChanged(result: FailedResult): boolean {
    if (result.status === 503 && result.error?.code === 'unavailable') return false;
    return result.status === 0 || result.status === 409 || result.status >= 500;
  }

  async function submit(): Promise<void> {
    if (busy !== 'idle' || target === null) return;
    const admin = adminToSend();
    if (admin === undefined) {
      await focusFailure(github ? 'username' : 'email');
      return;
    }
    busy = 'sending';
    errors = {};
    const epoch = dialogEpoch;
    const result = await callOperation(organizationAdminReassign, { slug: target.slug, admin });
    if (epoch !== dialogEpoch) {
      if (result.ok || mayHaveChanged(result)) await invalidateAll();
      return;
    }
    busy = 'idle';
    if (result.ok) {
      reloadOnClose = true;
      done = result.data.invite
        ? {
            kind: 'invite',
            email: result.data.admin_login_name,
            inviteUrl: result.data.invite.url,
            expiresAt: result.data.invite.expires_at,
          }
        : { kind: 'named', slug: result.data.slug, loginName: result.data.admin_login_name };
      return;
    }
    const failure = failureOf(result, 'send');
    if (failure === undefined) return;
    if (failure.code !== undefined && failure.field === 'username') resolved = null;
    errors = { [failure.field]: failure.key };
    await focusFailure(failure.field);
    if (mayHaveChanged(result)) await invalidateAll();
    // 見つからない組織は、閉じるときに一覧を読み直す（消えた組織を一覧に残さない）
    else if (result.status === 404) reloadOnClose = true;
  }

  async function copy(text: string, copiedKey: DictionaryKey): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      showToast(t(copiedKey), 'check');
    } catch {
      urlInput?.select();
      showToast(t('operatorCopyFailed'), 'alert');
    }
  }
</script>

<Dialog
  bind:this={dialog}
  bind:open
  dismissible={!sending}
  title={t(done === null ? 'operatorReassignTitle' : 'operatorReassignDoneTitle', words)}
>
  <!-- 読み上げの領域。常に置き、文字だけを替える（後から挿入した領域は読み上げられないことがある） -->
  <div class="visually-hidden" role="status">{live}</div>
  {#if done === null}
    <!-- 組織の名前は自由に付けられるので、長い名前や区切りのない名前でも折り返す -->
    <p class="wrap-anywhere">
      {target === null ? '' : t(leadKeys[target.admin_status], { ...words, name: target.name })}
    </p>
    <div class="field">
      <span class="field-label" id={viaLabelId}>{t('operatorReassignVia', words)}</span>
      <div class="segmented" role="radiogroup" aria-labelledby={viaLabelId}>
        <label>
          <input
            type="radio"
            name="{ids}-via"
            value="github"
            bind:group={via}
            disabled={sending}
            onchange={changeVia}
          />
          <span>{t('operatorGithubName')}</span>
        </label>
        <label>
          <input
            type="radio"
            name="{ids}-via"
            value="google"
            bind:group={via}
            disabled={sending}
            onchange={changeVia}
          />
          <span>{t('operatorGoogleName')}</span>
        </label>
      </div>
    </div>
    {#if github}
      <div class="field" class:is-invalid={errors.username}>
        <label class="field-label" for={fieldIds.username}>{t('operatorGithubUserLabel')}</label>
        <div class="input-row">
          <input
            class="input mono"
            id={fieldIds.username}
            bind:value={username}
            readonly={sending}
            maxlength={GITHUB_USERNAME_MAX_LENGTH}
            placeholder={t('operatorGithubUserExample')}
            autocomplete="off"
            spellcheck="false"
            aria-invalid={errors.username ? 'true' : undefined}
            aria-describedby={usernameDescribedBy}
            oninput={changeUsername}
            onkeydown={(event) => {
              if (event.key === 'Enter' && !event.isComposing) {
                event.preventDefault();
                void verify();
              }
            }}
          />
          <button class="btn" type="button" aria-disabled={busy !== 'idle'} onclick={verify}>
            {busy === 'resolving' ? t('operatorVerifying') : t('operatorVerify')}
          </button>
        </div>
        {#if errors.username}
          <span class="field-error" id="{ids}-username-error" role="alert"
            ><Icon name="alert" />{t(errors.username, words)}</span
          >
        {/if}
        <span class="field-hint" id="{ids}-username-hint">{t('operatorReassignGithubUserHint')}</span>
      </div>
      {#if resolved}
        <div class="callout is-info">
          <Icon name="shield" /><span>{t('operatorReassignVerifyLead', words)}</span>
        </div>
        <div class="choice is-static">
          <Avatar userId={resolved.loginSubject} name={resolved.loginName} image={resolved.avatarUrl} large />
          <div>
            <b class="mono">{resolved.loginName}</b>
            <span>{resolved.displayName ?? t('operatorNoDisplayName')}</span>
            <span>{t('operatorGithubId', { id: resolved.loginSubject })}</span>
          </div>
        </div>
      {/if}
    {:else}
      <div class="field" class:is-invalid={errors.email}>
        <label class="field-label" for={fieldIds.email}>{t('operatorGoogleEmailLabel')}</label>
        <input
          class="input mono"
          id={fieldIds.email}
          bind:value={email}
          readonly={sending}
          maxlength={EMAIL_MAX_LENGTH}
          inputmode="email"
          placeholder={t('operatorGoogleEmailExample')}
          autocomplete="off"
          spellcheck="false"
          aria-invalid={errors.email ? 'true' : undefined}
          aria-describedby={emailDescribedBy}
          oninput={changeEmail}
          onkeydown={(event) => {
            if (event.key === 'Enter' && !event.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {#if errors.email}
          <span class="field-error" id="{ids}-email-error" role="alert"
            ><Icon name="alert" />{t(errors.email, words)}</span
          >
        {/if}
        <span class="field-hint" id="{ids}-email-hint">{t('operatorGoogleEmailHint', words)}</span>
      </div>
    {/if}
    <p class="field-hint">{t('operatorReassignNote', words)}</p>
    <p class="field-hint">{t('operatorReassignHistoryNote', words)}</p>
    {#if errors.form}
      <div class="callout is-danger" role="alert" tabindex="-1" bind:this={formCallout}>
        <Icon name="alert" /><span>{t(errors.form, words)}</span>
      </div>
    {/if}
  {:else if done.kind === 'invite'}
    <!-- Google の指名。招待の URL は応答の本文にだけあり、この表示を閉じると二度と出ない -->
    <p tabindex="-1" bind:this={doneLead}>{t('operatorInviteLead', words)}</p>
    <div class="field">
      <label class="field-label" for="{ids}-invite-url">{t('operatorInviteUrlLabel')}</label>
      <div class="input-row">
        <input class="input mono" id="{ids}-invite-url" value={done.inviteUrl} readonly bind:this={urlInput} />
        <button
          class="btn"
          type="button"
          onclick={() => done?.kind === 'invite' && copy(done.inviteUrl, 'operatorInviteCopied')}
          ><Icon name="link" />{t('operatorCopy')}</button
        >
      </div>
    </div>
    <div class="callout is-info">
      <Icon name="check" />
      <span>
        {t('operatorInviteTell')}
        <b class="mono wrap-anywhere">{done.email}</b>
      </span>
    </div>
    <div class="callout is-warn">
      <Icon name="alert" /><span>{t('operatorInviteOnce', { expires: formatDateTime(done.expiresAt) })}</span>
    </div>
    <p class="field-hint">{t('operatorInviteReissue', words)}</p>
  {:else}
    <p tabindex="-1" bind:this={doneLead}>{t('operatorDoneLead', words)}</p>
    <div class="field">
      <label class="field-label" for="{ids}-url">{t('operatorDoneUrlLabel', words)}</label>
      <div class="input-row">
        <input class="input mono" id="{ids}-url" value={organizationUrl} readonly bind:this={urlInput} />
        <button class="btn" type="button" onclick={() => copy(organizationUrl, 'operatorCopied')}
          ><Icon name="link" />{t('operatorCopy')}</button
        >
      </div>
    </div>
    <div class="callout is-info">
      <Icon name="check" /><span>{t('operatorDoneTell', { name: done.loginName })}</span>
    </div>
  {/if}
  {#snippet footer(close)}
    {#if done === null}
      <button class="btn is-quiet" type="button" aria-disabled={sending} onclick={close}>
        {t('operatorCancel')}
      </button>
      <button class="btn is-primary" type="button" disabled={!ready} aria-disabled={busy !== 'idle'} onclick={submit}>
        {sending ? t('operatorReassignSubmitting') : t('operatorReassignSubmit')}
      </button>
    {:else}
      <button class="btn is-primary" type="button" onclick={close}>{t('close')}</button>
    {/if}
  {/snippet}
</Dialog>
