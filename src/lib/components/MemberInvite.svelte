<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import { tick } from 'svelte';
  import { callOperation, type ApiResult } from '../api.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import { GITHUB_USERNAME_MAX_LENGTH } from '../../shared/operations/operator/index.ts';
  import { invitationCreate, inviteeResolve } from '../../shared/operations/workspace/index.ts';
  import type { DictionaryKey } from '../../shared/vocabulary.ts';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';

  // design/members.html の「招待する」の節の中身（.panel）。リーダーと管理者にだけ出す（出すかはメンバーの画面が決める）。
  // 順は、GitHub のユーザー名を入れ、「確かめる」で解決して招待する人（アバター、ユーザー名、表示名）を見て確かめ、ロールを選んで招待する。
  // 打ち間違いで別の人を招待しないため、確かめるまで招待できない。招待するときは確かめたユーザー ID を渡し、サーバーが解決し直して
  // 違えば断る（運用者の組織の作成のダイアログ CreateOrganizationDialog と同じ作り）。ログインの手段は GitHub だけを出す（Google は #190）。
  // 組織の人数が上限に達しているときは、理由と管理者に相談するよう出す。確かめることはでき、確かめた人がまだ人数に数えられて
  // いなければ（invitee-resolve の already_counted が偽）、理由を添えて招待のボタンを押せなくする（数えられている人は招待できる）。
  // 応答が遅れて届いても、古い入力の結果で今の状態を書き換えない（ユーザー名を直すと世代が進み、前の応答を捨てる）。
  // 招待できたら、承諾待ちの一覧と人数を読み直す（onchanged）。権限を失った、ワークスペースが閉じた、などは画面ごと読み直す
  let {
    slug,
    workspaceId,
    seats,
    onchanged,
  }: {
    slug: string;
    workspaceId: string;
    seats: { used: number; limit: number };
    onchanged: () => Promise<void>;
  } = $props();

  type Resolved = {
    username: string;
    loginSubject: string;
    loginName: string;
    displayName: string | null;
    avatarUrl: string | null;
    // すでに組織の人数に数えられている人か（上限に達していても招待できる）
    alreadyCounted: boolean;
  };
  type Field = 'username' | 'form';
  type FailedResult = Extract<ApiResult<unknown>, { ok: false }>;

  let username = $state('');
  let role = $state<'member' | 'leader'>('member');
  let resolved = $state<Resolved | null>(null);
  let busy = $state<'idle' | 'resolving' | 'inviting'>('idle');
  let error = $state<{ field: Field; key: DictionaryKey } | null>(null);
  // 招待の送信が上限（member_limit_reached）で断られた。上限の枠を role="alert" で出してフォーカスを移す
  let limitAlert = $state(false);
  let formCallout = $state<HTMLElement>();
  let limitCallout = $state<HTMLElement>();
  let inputEpoch = 0;

  const full = $derived(seats.used >= seats.limit);
  // 上限に達していても、すでに人数に数えられている人は招待できる
  const blockedByLimit = $derived((full || limitAlert) && resolved !== null && !resolved.alreadyCounted);
  const inviting = $derived(busy === 'inviting');
  const words = $derived({ organization: t('organization'), admin: t('admin'), workspace: t('workspace') });
  const organizationUrl = $derived(`${page.url.origin}/${slug}/`);
  const usernameDescribedBy = $derived(
    error?.field === 'username' ? 'invite-username-error invite-username-hint' : 'invite-username-hint',
  );
  // 読み上げの領域の文字。領域は常に置き、文字だけを替える。失敗したときは、理由を出す枠（role="alert"）が読み上げるので空にする
  const live = $derived(
    busy === 'inviting'
      ? t('inviteSubmitting')
      : busy === 'resolving'
        ? t('inviteVerifying')
        : error !== null || limitAlert
          ? ''
          : resolved !== null
            ? t('inviteLiveVerified', { name: resolved.loginName })
            : '',
  );

  // 入力の誤りの理由（details の code）と、409 の code を、辞書のキーに写す
  const problemKeys: Record<string, DictionaryKey> = {
    github_user_not_found: 'inviteErrorUserNotFound',
    github_not_a_user: 'inviteErrorNotUser',
  };
  const conflictKeys: Record<string, DictionaryKey> = {
    invitee_changed: 'inviteErrorUserChanged',
    already_member: 'inviteErrorAlreadyMember',
    already_invited: 'inviteErrorAlreadyInvited',
  };

  function problemCodeOf(result: FailedResult): string | undefined {
    const details = result.error?.details;
    if (!Array.isArray(details)) return undefined;
    for (const item of details as unknown[]) {
      if (typeof item === 'object' && item !== null && 'code' in item && typeof item.code === 'string') {
        if (Object.hasOwn(problemKeys, item.code)) return item.code;
      }
    }
    return undefined;
  }

  // 失敗を、どの欄にどの文言を出すかに写す。画面ごと読み直す失敗は、トーストで知らせて null を返す。
  // context は、ユーザー名を確かめる（verify）か、招待する（invite）か
  async function failureOf(
    result: FailedResult,
    context: 'verify' | 'invite',
  ): Promise<{ field: Field; key: DictionaryKey } | null> {
    if (isUnauthenticated(result)) {
      window.location.assign(loginUrl(page.url));
      return null;
    }
    const code = result.error?.code;
    // 閉じた、権限を失った、ワークスペースが見つからない: 節ごと消えることがあるので、トーストで知らせて画面を読み直す
    if (code === 'workspace_closed' || result.status === 403 || result.status === 404) {
      showToast(t(code === 'workspace_closed' ? 'inviteErrorClosed' : 'inviteErrorForbidden', words), 'alert');
      await invalidate('app:workspace');
      await onchanged();
      return null;
    }
    // 人数が上限に達していて、この人はまだ数えられていない: 上限の枠を alert で出し、人数を読み直す
    if (code === 'member_limit_reached') {
      limitAlert = true;
      if (resolved !== null) resolved = { ...resolved, alreadyCounted: false };
      await onchanged();
      await tick();
      limitCallout?.focus();
      return null;
    }
    const problem = problemCodeOf(result);
    if (problem !== undefined) return { field: 'username', key: problemKeys[problem]! };
    if (code !== undefined && Object.hasOwn(conflictKeys, code)) return { field: 'username', key: conflictKeys[code]! };
    // 回数の上限。招待の送信では、確かめた結果を残したまま、しばらく後に押し直せるようにする
    if (code === 'rate_limited') {
      return context === 'verify'
        ? { field: 'username', key: 'inviteErrorTooMany' }
        : { field: 'form', key: 'inviteErrorTooManyInvites' };
    }
    if (result.status === 503) {
      return { field: context === 'verify' ? 'username' : 'form', key: 'inviteErrorGithubUnavailable' };
    }
    if (context === 'verify') {
      return { field: 'username', key: result.status === 0 ? 'inviteErrorUnreachable' : 'inviteErrorVerifyFailed' };
    }
    // 招待できたか分からない失敗（通信の切れ、5xx）。一覧を読み直して、入っていれば見えるようにする
    await onchanged();
    return { field: 'form', key: result.status === 0 ? 'inviteErrorUnreachable' : 'inviteErrorFailed' };
  }

  // 失敗した欄へフォーカスを移す。欄に紐づかない失敗は、誤りを出した枠（callout）へ移す
  async function focusFailure(field: Field): Promise<void> {
    await tick();
    if (field === 'form') formCallout?.focus();
    else document.getElementById('invite-username')?.focus();
  }

  // ユーザー名を直したら、確かめた結果は捨てる（確かめた人と違う人を招待しないため）。確かめている最中の応答も捨てる
  function changeUsername(): void {
    inputEpoch++;
    resolved = null;
    if (busy === 'resolving') busy = 'idle';
    error = null;
    limitAlert = false;
  }

  async function verify(): Promise<void> {
    if (busy !== 'idle') return;
    const value = username.trim();
    if (value === '') {
      error = { field: 'username', key: 'inviteErrorUserRequired' };
      await focusFailure('username');
      return;
    }
    resolved = null;
    error = null;
    limitAlert = false;
    busy = 'resolving';
    const epoch = inputEpoch;
    const result = await callOperation(
      inviteeResolve,
      { workspace_id: workspaceId, provider: 'github', username: value },
      { slug },
    );
    // ユーザー名を直した後に届いた応答は、今の入力のものではないので捨てる
    if (epoch !== inputEpoch) return;
    busy = 'idle';
    if (result.ok) {
      resolved = {
        username: value,
        loginSubject: result.data.login_subject,
        loginName: result.data.login_name,
        displayName: result.data.display_name,
        avatarUrl: result.data.avatar_url,
        alreadyCounted: result.data.already_counted,
      };
      return;
    }
    const failure = await failureOf(result, 'verify');
    if (failure === null) return;
    error = failure;
    await focusFailure(failure.field);
  }

  async function submit(): Promise<void> {
    if (busy !== 'idle' || resolved === null || blockedByLimit) return;
    // 確かめた人と、欄のユーザー名が違うまま招待しない（欄を直したら確かめた結果は捨てるが、念のため送る前にも見る）
    if (username.trim() !== resolved.username) {
      resolved = null;
      error = { field: 'username', key: 'inviteErrorVerifyAgain' };
      await focusFailure('username');
      return;
    }
    const sent = resolved;
    error = null;
    busy = 'inviting';
    const result = await callOperation(
      invitationCreate,
      {
        workspace_id: workspaceId,
        provider: 'github',
        username: sent.username,
        login_subject: sent.loginSubject,
        role,
      },
      { slug },
    );
    busy = 'idle';
    if (result.ok) {
      inputEpoch++;
      username = '';
      resolved = null;
      limitAlert = false;
      role = 'member';
      showToast(t('inviteDone', { name: result.data.login_name }), 'check');
      await onchanged();
      // 続けて別の人を招待できるよう、ユーザー名の欄へ戻す
      await tick();
      document.getElementById('invite-username')?.focus();
      return;
    }
    const failure = await failureOf(result, 'invite');
    // ユーザー名にかかわる理由（持ち主が変わった、所属している、招待済み、見つからない）は、確かめた結果を捨てる
    if (failure?.field === 'username') resolved = null;
    if (failure === null) return;
    error = failure;
    await focusFailure(failure.field);
  }
</script>

<div class="panel">
  <!-- 読み上げの領域。常に置き、文字だけを替える（後から挿入した領域は読み上げられないことがある） -->
  <div class="visually-hidden" role="status">{live}</div>
  {#if full || limitAlert}
    <div class="callout is-warn" role={limitAlert ? 'alert' : undefined} tabindex="-1" bind:this={limitCallout}>
      <Icon name="alert" /><span>{t('inviteLimitReached', { ...words, limit: String(seats.limit) })}</span>
    </div>
  {/if}
  <div class="form-row is-start">
    <div class="field">
      <span class="field-label" id="invite-via-label">{t('inviteViaLabel')}</span>
      <div class="segmented" role="radiogroup" aria-labelledby="invite-via-label">
        <label>
          <input type="radio" name="invite-via" value="github" checked />
          <span>{t('loginProviderGithub')}</span>
        </label>
      </div>
    </div>
    <div class="field" class:is-invalid={error?.field === 'username'}>
      <label class="field-label" for="invite-username">{t('inviteGithubUserLabel')}</label>
      <div class="input-row">
        <input
          class="input mono"
          id="invite-username"
          bind:value={username}
          readonly={inviting}
          maxlength={GITHUB_USERNAME_MAX_LENGTH}
          placeholder={t('inviteGithubUserExample')}
          autocomplete="off"
          spellcheck="false"
          aria-invalid={error?.field === 'username' ? 'true' : undefined}
          aria-describedby={usernameDescribedBy}
          oninput={changeUsername}
          onkeydown={(event) => {
            if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
              event.preventDefault();
              void verify();
            }
          }}
        />
        <button class="btn" type="button" aria-disabled={busy !== 'idle'} onclick={verify}>
          {busy === 'resolving' ? t('inviteVerifying') : t('inviteVerify')}
        </button>
      </div>
      {#if error?.field === 'username'}
        <span class="field-error" id="invite-username-error" role="alert"
          ><Icon name="alert" />{t(error.key, words)}</span
        >
      {/if}
      <span class="field-hint" id="invite-username-hint">{t('inviteGithubUserHint')}</span>
    </div>
  </div>
  {#if resolved}
    <div class="callout is-info">
      <Icon name="shield" /><span>{t('inviteVerifyLead')}</span>
    </div>
    <div class="choice is-static">
      <Avatar userId={resolved.loginSubject} name={resolved.loginName} image={resolved.avatarUrl} large />
      <div>
        <b class="mono">{resolved.loginName}</b>
        <span>{resolved.displayName ?? t('inviteNoDisplayName')}</span>
        <span>{t('inviteGithubId', { id: resolved.loginSubject })}</span>
      </div>
    </div>
    {#if blockedByLimit}
      <p class="props-note" id="invite-limit-note">{t('inviteNotCountedAtLimit', words)}</p>
    {/if}
  {/if}
  <div class="form-row">
    <div class="field">
      <span class="field-label" id="invite-role-label">{t('memberRoleHeader')}</span>
      <div class="segmented" role="radiogroup" aria-labelledby="invite-role-label">
        <label>
          <input type="radio" name="invite-role" value="member" bind:group={role} disabled={inviting} />
          <span>{t('roleMember')}</span>
        </label>
        <label>
          <input type="radio" name="invite-role" value="leader" bind:group={role} disabled={inviting} />
          <span>{t('leader')}</span>
        </label>
      </div>
    </div>
    <button
      class="btn is-primary"
      type="button"
      disabled={resolved === null || blockedByLimit}
      aria-disabled={busy !== 'idle'}
      aria-describedby={blockedByLimit ? 'invite-limit-note' : undefined}
      onclick={submit}
    >
      <Icon name="mail" />{inviting ? t('inviteSubmitting') : t('inviteSubmit')}
    </button>
  </div>
  {#if error?.field === 'form'}
    <div class="callout is-danger" role="alert" tabindex="-1" bind:this={formCallout}>
      <Icon name="alert" /><span>{t(error.key, words)}</span>
    </div>
  {/if}
  <span class="field-hint">{t('inviteSendNote', words)} <span class="mono wrap-anywhere">{organizationUrl}</span></span>
</div>
