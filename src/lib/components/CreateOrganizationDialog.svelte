<script lang="ts">
  import { tick } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { callOperation, type ApiResult } from '../api.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import { slugProblem } from '../../shared/organization-slug.ts';
  import {
    createOrganization,
    GITHUB_USERNAME_MAX_LENGTH,
    hasHiddenCharacter,
    ORGANIZATION_NAME_MAX_LENGTH,
    resolveGithubUser,
    type AdminStatus,
  } from '../../shared/operations/operator/index.ts';
  import type { DictionaryKey } from '../../shared/vocabulary.ts';
  import Avatar from './Avatar.svelte';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // design/kit.js の createOrganization。運用者が組織を作るダイアログ。
  // 順は、slug と表示名を入れ、最初の管理者のログインの手段を選び、GitHub のユーザー名を解決して指名する人（アバター、
  // ユーザー名、表示名）を見て確かめ、作る。打ち間違いで別の人を管理者にしないため、確かめるまで作れない。
  // 作るときは確かめたユーザー ID を渡し、サーバーが解決し直して違えば断る。作った後は、同じダイアログを完了の表示に切り替え、
  // 組織の URL（コピーできる）と、管理者になる人に伝えることを出す。
  //
  // 応答が遅れて届いても、古い入力の結果で今の状態を書き換えない。要求を送るときの世代を覚え、応答のときに世代が
  // 進んでいれば捨てる。dialogEpoch はダイアログの開閉、inputEpoch はユーザー名と手段の変更で進む。
  // 作っている間は、入力欄と手段を読み取り専用にし、閉じる操作を無視する（応答を見失わない）。
  // 作れたか分からない失敗（通信の切れ、5xx、slug の重なり）の後は、一覧を読み直し、同じ slug の組織があれば、このダイアログの中で示す。
  // organizations は一覧の今の内容（運用の画面が渡す。読み直すと入れ替わる）
  let {
    open = $bindable(false),
    organizations = [],
  }: {
    open?: boolean;
    organizations?: readonly { slug: string; name: string; admin_status: AdminStatus }[];
  } = $props();

  type Resolved = {
    username: string;
    loginSubject: string;
    loginName: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  // admin が named: この操作で作れた（指名した人を確かめている）。existing: 作れたか分からない失敗の後に、読み直した一覧で
  // 見つけた組織。管理者がダイアログで確かめた人とは限らない（別の運用者が、別の人を指名して作ったかもしれない）ので、
  // 人の名前は出さず、一覧の管理者の状態だけを持つ
  type Created = {
    slug: string;
    name: string;
    admin: { kind: 'named'; loginName: string } | { kind: 'existing'; status: AdminStatus };
  };
  type Existing = { slug: string; name: string; sameName: boolean; adminStatus: AdminStatus };
  type Field = 'slug' | 'name' | 'username' | 'form';
  type FailedResult = Extract<ApiResult<unknown>, { ok: false }>;

  let dialog = $state<ReturnType<typeof Dialog>>();
  let slug = $state('');
  let name = $state('');
  let via = $state<'github' | 'google'>('github');
  let username = $state('');
  let resolved = $state<Resolved | null>(null);
  let created = $state<Created | null>(null);
  let existing = $state<Existing | null>(null);
  let busy = $state<'idle' | 'resolving' | 'creating'>('idle');
  let errors = $state<Partial<Record<Field, DictionaryKey>>>({});
  let doneLead = $state<HTMLElement>();
  let urlInput = $state<HTMLInputElement>();
  let formCallout = $state<HTMLElement>();
  let dialogEpoch = 0;
  let inputEpoch = 0;

  const words = $derived({ organization: t('organization'), admin: t('admin') });
  const organizationUrl = $derived(created === null ? '' : `${page.url.origin}/${created.slug}/`);
  const github = $derived(via === 'github');
  const creating = $derived(busy === 'creating');
  const usernameDescribedBy = $derived(
    errors.username ? 'operator-username-error operator-username-hint' : 'operator-username-hint',
  );
  const slugDescribedBy = $derived(errors.slug ? 'operator-slug-error operator-slug-hint' : 'operator-slug-hint');
  // 読み上げの領域の文字。領域は常に置き、文字だけを替える
  const live = $derived(
    created !== null
      ? t(created.admin.kind === 'named' ? 'operatorLiveCreated' : 'operatorLiveExisting', words)
      : busy === 'creating'
        ? t('operatorLiveCreating')
        : busy === 'resolving'
          ? t('operatorLiveVerifying')
          : resolved !== null
            ? t('operatorLiveVerified', { name: resolved.loginName })
            : '',
  );

  export function show(trigger?: HTMLElement | null): void {
    dialog?.show(trigger);
  }

  // 開くときと閉じるときに入力を捨てる。作り終えた後の閉じ方も、途中でやめる閉じ方も同じ。
  // 世代を進めるので、閉じる前に送った要求の応答は、開き直した後の状態に入らない
  function reset(): void {
    dialogEpoch++;
    inputEpoch++;
    slug = '';
    name = '';
    via = 'github';
    username = '';
    resolved = null;
    created = null;
    existing = null;
    busy = 'idle';
    errors = {};
  }

  $effect(() => {
    void open;
    reset();
  });

  // 完了の表示に切り替わったら、フォーカスを消えたボタンから本文に移す（読み上げが続きを読める）
  $effect(() => {
    if (created !== null) doneLead?.focus();
  });

  // 入力の誤りの理由（details の code）を、辞書のキーに写す。ユーザー名にかかわる理由は、確かめた結果を捨てる
  const problemKeys: Record<string, DictionaryKey> = {
    slug_format: 'operatorErrorSlugFormat',
    slug_reserved: 'operatorErrorSlugReserved',
    github_user_not_found: 'operatorErrorUserNotFound',
    github_not_a_user: 'operatorErrorNotUser',
    github_user_changed: 'operatorErrorUserChanged',
  };
  const usernameProblems = ['github_user_not_found', 'github_not_a_user', 'github_user_changed'];

  type Problem = { path?: string; code?: string };

  function problemsOf(result: FailedResult): Problem[] {
    const details = result.error?.details;
    if (!Array.isArray(details)) return [];
    return details.flatMap((item: unknown): Problem[] => {
      if (typeof item !== 'object' || item === null) return [];
      return [
        {
          path: 'path' in item && typeof item.path === 'string' ? item.path : undefined,
          code: 'code' in item && typeof item.code === 'string' ? item.code : undefined,
        },
      ];
    });
  }

  type Failure = { field: Field; key: DictionaryKey; code?: string };

  // 失敗を、どの欄にどの文言を出すかに写す。ログインが切れた、運用者でなくなった人は、画面ごと移す。
  // context は、ユーザー名を確かめる（verify）か、作る（create）か。
  // 「届きませんでした」は通信が切れたとき（status 0）だけ。作る段の通信の切れと 5xx は、サーバーで作られていることがあるので、
  // 一覧を確かめるよう伝える
  function failureOf(result: FailedResult, context: 'verify' | 'create'): Failure {
    if (isUnauthenticated(result)) window.location.assign(loginUrl(page.url));
    else if (result.status === 403) window.location.assign('/');
    const problems = problemsOf(result);
    const known = problems.find((problem) => problem.code !== undefined && Object.hasOwn(problemKeys, problem.code));
    if (known?.code !== undefined) {
      return {
        field: known.code.startsWith('slug_') ? 'slug' : 'username',
        key: problemKeys[known.code]!,
        code: known.code,
      };
    }
    if (result.status === 400) {
      if (problems.some((problem) => problem.path === 'name'))
        return { field: 'name', key: 'operatorErrorNameInvalid' };
      return { field: context === 'verify' ? 'username' : 'form', key: 'operatorErrorInvalid' };
    }
    if (result.status === 409) return { field: 'slug', key: 'operatorErrorSlugTaken' };
    // GitHub に届かないのは、組織を作る前（解決の段）。何も書かれていない
    if (result.status === 503) {
      return { field: context === 'verify' ? 'username' : 'form', key: 'operatorErrorGithubUnavailable' };
    }
    if (context === 'verify') {
      return { field: 'username', key: result.status === 0 ? 'operatorErrorUnreachable' : 'operatorErrorVerifyFailed' };
    }
    return { field: 'form', key: 'operatorErrorCreate' };
  }

  const fieldIds: Record<Exclude<Field, 'form'>, string> = {
    slug: 'operator-slug',
    name: 'operator-name',
    username: 'operator-username',
  };

  // 失敗した欄へフォーカスを移す。欄に紐づかない失敗は、誤りを出した枠（callout）へ移す
  async function focusFailure(field: Field): Promise<void> {
    await tick();
    if (field === 'form') formCallout?.focus();
    else document.getElementById(fieldIds[field])?.focus();
  }

  // 作る前の確かめで、誤りのある最初の欄へフォーカスを移す
  async function focusFirstInvalid(): Promise<void> {
    await tick();
    document.querySelector<HTMLElement>('dialog[open] [aria-invalid="true"]')?.focus();
  }

  // 手段を替えたら、確かめた結果と、ユーザー名の誤りは捨てる。slug と表示名の誤りは残す
  function changeVia(): void {
    inputEpoch++;
    resolved = null;
    if (busy === 'resolving') busy = 'idle';
    errors = { slug: errors.slug, name: errors.name };
  }

  // ユーザー名を直したら、確かめた結果は捨てる（確かめた人と違う人を指名しないため）。確かめている最中の応答も捨てる
  function changeUsername(): void {
    inputEpoch++;
    resolved = null;
    if (busy === 'resolving') busy = 'idle';
    errors = { ...errors, username: undefined };
  }

  // slug と表示名を直したら、読み直した一覧との照合の結果は古い
  function changeNameOrSlug(field: 'slug' | 'name'): void {
    existing = null;
    errors = { ...errors, [field]: undefined };
  }

  async function verify(): Promise<void> {
    if (busy !== 'idle' || !github) return;
    const value = username.trim();
    if (value === '') {
      errors = { ...errors, username: 'operatorErrorUserRequired' };
      await focusFirstInvalid();
      return;
    }
    // 確かめ直す間は、前の確かめた結果で作れないようにする
    resolved = null;
    errors = { ...errors, username: undefined, form: undefined };
    busy = 'resolving';
    const epochs = { dialog: dialogEpoch, input: inputEpoch };
    const result = await callOperation(resolveGithubUser, { username: value });
    // 閉じた、開き直した、ユーザー名や手段を直した後に届いた応答は、今の入力のものではないので捨てる
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
    errors = { ...errors, [failure.field]: failure.key };
    await focusFailure(failure.field);
  }

  // 作る前の確かめ。サーバーも同じ確かめをする（ここは入力の誤りをすぐ知らせるため。slug は貼り付けで黙って切れないよう、
  // 入力欄では切らず、ここで 2〜40 字の外を断る）
  function validate(): boolean {
    const next: Partial<Record<Field, DictionaryKey>> = {};
    const trimmedSlug = slug.trim();
    const problem = trimmedSlug === '' ? undefined : slugProblem(trimmedSlug);
    if (trimmedSlug === '') next.slug = 'operatorErrorSlugRequired';
    else if (problem === 'format') next.slug = 'operatorErrorSlugFormat';
    else if (problem === 'reserved') next.slug = 'operatorErrorSlugReserved';
    const trimmedName = name.trim();
    if (trimmedName === '') next.name = 'operatorErrorNameRequired';
    else if (trimmedName.length > ORGANIZATION_NAME_MAX_LENGTH) next.name = 'operatorErrorNameLong';
    else if (hasHiddenCharacter(trimmedName)) next.name = 'operatorErrorNameInvalid';
    errors = next;
    return Object.keys(next).length === 0;
  }

  // 作れたか分からない失敗: 通信の切れ、本文が JSON でない 200、slug の重なり（自分が作ったものかもしれない）、5xx すべて
  function mayHaveCreated(result: ApiResult<unknown>): boolean {
    if (result.ok) return true;
    return result.status === 0 || result.status === 200 || result.status === 409 || result.status >= 500;
  }

  async function submit(): Promise<void> {
    if (busy !== 'idle' || resolved === null) return;
    // 確かめた人と、欄のユーザー名が違うまま作らない（欄を直したら確かめた結果は捨てるが、念のため送る前にも見る）
    if (username.trim() !== resolved.username) {
      resolved = null;
      errors = { ...errors, username: 'operatorErrorVerifyAgain' };
      await focusFirstInvalid();
      return;
    }
    if (!validate()) {
      await focusFirstInvalid();
      return;
    }
    existing = null;
    busy = 'creating';
    const epoch = dialogEpoch;
    const sent = { slug: slug.trim(), name: name.trim() };
    const result = await callOperation(createOrganization, {
      ...sent,
      admin: { provider: 'github', username: resolved.username, login_subject: resolved.loginSubject },
    });
    const refresh = mayHaveCreated(result);
    // 閉じた、開き直した後に届いた応答は、今のダイアログの状態に入れない（作っている間は閉じられないが、念のため）
    if (epoch !== dialogEpoch) {
      if (refresh) await invalidateAll();
      return;
    }
    busy = 'idle';
    if (result.ok) {
      created = {
        slug: result.data.slug,
        name: result.data.name,
        admin: { kind: 'named', loginName: result.data.admin_login_name },
      };
      await invalidateAll();
      return;
    }
    const failure = failureOf(result, 'create');
    if (failure.code !== undefined && usernameProblems.includes(failure.code)) resolved = null;
    errors = { [failure.field]: failure.key };
    await focusFailure(failure.field);
    if (!refresh) return;
    // 一覧を読み直し、同じ slug の組織があれば、このダイアログの中で示す（閉じると入力が消えるため）
    await invalidateAll();
    if (epoch !== dialogEpoch) return;
    const found = organizations.find((item) => item.slug === sent.slug);
    if (found !== undefined) {
      existing = {
        slug: found.slug,
        name: found.name,
        sameName: found.name === sent.name,
        adminStatus: found.admin_status,
      };
    }
  }

  // 読み直した一覧にあった組織の表示に切り替える。組織の URL と、一覧の管理者の状態だけを出す。
  // 管理者がダイアログで確かめた人だとは限らないので、ログインするユーザー名は出さない
  function showExisting(): void {
    if (existing === null) return;
    created = {
      slug: existing.slug,
      name: existing.name,
      admin: { kind: 'existing', status: existing.adminStatus },
    };
    existing = null;
    errors = {};
  }

  async function copyUrl(): Promise<void> {
    try {
      await navigator.clipboard.writeText(organizationUrl);
      showToast(t('operatorCopied'), 'check');
    } catch {
      urlInput?.select();
      showToast(t('operatorCopyFailed'), 'alert');
    }
  }
</script>

<Dialog
  bind:this={dialog}
  bind:open
  dismissible={!creating}
  title={t(
    created === null
      ? 'operatorCreateTitle'
      : created.admin.kind === 'named'
        ? 'operatorDoneTitle'
        : 'operatorExistingTitle',
    words,
  )}
>
  <!-- 読み上げの領域。常に置き、文字だけを替える（後から挿入した領域は読み上げられないことがある） -->
  <div class="visually-hidden" role="status">{live}</div>
  {#if created === null}
    <div class="field" class:is-invalid={errors.slug}>
      <label class="field-label" for="operator-slug">{t('operatorSlugLabel')}</label>
      <input
        class="input mono"
        id="operator-slug"
        bind:value={slug}
        readonly={creating}
        placeholder={t('operatorSlugExample')}
        autocomplete="off"
        spellcheck="false"
        aria-invalid={errors.slug ? 'true' : undefined}
        aria-describedby={slugDescribedBy}
        oninput={() => changeNameOrSlug('slug')}
      />
      {#if errors.slug}
        <span class="field-error" id="operator-slug-error" role="alert"
          ><Icon name="alert" />{t(errors.slug, words)}</span
        >
      {/if}
      <span class="field-hint" id="operator-slug-hint">{t('operatorSlugHint')}</span>
    </div>
    <div class="field" class:is-invalid={errors.name}>
      <label class="field-label" for="operator-name">{t('operatorNameLabel')}</label>
      <input
        class="input"
        id="operator-name"
        bind:value={name}
        readonly={creating}
        maxlength={ORGANIZATION_NAME_MAX_LENGTH}
        placeholder={t('operatorNameExample')}
        autocomplete="off"
        aria-invalid={errors.name ? 'true' : undefined}
        aria-describedby={errors.name ? 'operator-name-error' : undefined}
        oninput={() => changeNameOrSlug('name')}
      />
      {#if errors.name}
        <span class="field-error" id="operator-name-error" role="alert"
          ><Icon name="alert" />{t(errors.name, words)}</span
        >
      {/if}
    </div>
    <div class="field">
      <span class="field-label" id="operator-via-label">{t('operatorAdminVia', words)}</span>
      <div class="segmented" role="radiogroup" aria-labelledby="operator-via-label">
        <label>
          <input
            type="radio"
            name="operator-via"
            value="github"
            bind:group={via}
            disabled={creating}
            onchange={changeVia}
          />
          <span>{t('operatorGithubName')}</span>
        </label>
        <label>
          <input
            type="radio"
            name="operator-via"
            value="google"
            bind:group={via}
            disabled={creating}
            onchange={changeVia}
          />
          <span>{t('operatorGoogleName')}</span>
        </label>
      </div>
    </div>
    {#if github}
      <div class="field" class:is-invalid={errors.username}>
        <label class="field-label" for="operator-username">{t('operatorGithubUserLabel')}</label>
        <div class="input-row">
          <input
            class="input mono"
            id="operator-username"
            bind:value={username}
            readonly={creating}
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
          <span class="field-error" id="operator-username-error" role="alert"
            ><Icon name="alert" />{t(errors.username, words)}</span
          >
        {/if}
        <span class="field-hint" id="operator-username-hint">{t('operatorGithubUserHint')}</span>
      </div>
      {#if resolved}
        <div class="callout is-info">
          <Icon name="shield" /><span>{t('operatorVerifyLead', words)}</span>
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
      <div class="callout is-warn"><Icon name="alert" /><span>{t('operatorGoogleSoon')}</span></div>
    {/if}
    {#if errors.form}
      <div class="callout is-danger" role="alert" tabindex="-1" bind:this={formCallout}>
        <Icon name="alert" /><span>{t(errors.form, words)}</span>
      </div>
    {/if}
    {#if existing}
      <div class="callout is-warn">
        <Icon name="alert" />
        <span>
          {t(existing.sameName ? 'operatorAlreadyCreated' : 'operatorAlreadyCreatedOther', {
            ...words,
            slug: existing.slug,
          })}
          {#if existing.adminStatus === 'none'}{t('operatorAlreadyCreatedNoAdmin', words)}{/if}
        </span>
      </div>
      {#if existing.sameName}
        <div class="form-actions">
          <button class="btn" type="button" onclick={showExisting}>{t('operatorShowCreated', words)}</button>
        </div>
      {/if}
    {/if}
  {:else}
    <p tabindex="-1" bind:this={doneLead}>
      {t(created.admin.kind === 'named' ? 'operatorDoneLead' : 'operatorExistingLead', words)}
    </p>
    <div class="field">
      <label class="field-label" for="operator-url">{t('operatorDoneUrlLabel', words)}</label>
      <div class="input-row">
        <input class="input mono" id="operator-url" value={organizationUrl} readonly bind:this={urlInput} />
        <button class="btn" type="button" onclick={copyUrl}><Icon name="link" />{t('operatorCopy')}</button>
      </div>
    </div>
    {#if created.admin.kind === 'named'}
      <div class="callout is-info">
        <Icon name="check" /><span>{t('operatorDoneTell', { name: created.admin.loginName })}</span>
      </div>
    {:else if created.admin.status === 'none'}
      <div class="callout is-danger"><Icon name="alert" /><span>{t('operatorAlreadyCreatedNoAdmin', words)}</span></div>
    {:else}
      <div class="callout is-info">
        <Icon name="shield" />
        <span>
          {t(
            created.admin.status === 'pending' ? 'operatorExistingAdminPending' : 'operatorExistingAdminActive',
            words,
          )}
        </span>
      </div>
    {/if}
  {/if}
  {#snippet footer(close)}
    {#if created === null}
      <button class="btn is-quiet" type="button" aria-disabled={creating} onclick={close}>
        {t('operatorCancel')}
      </button>
      <button
        class="btn is-primary"
        type="button"
        disabled={resolved === null || !github}
        aria-disabled={busy !== 'idle'}
        onclick={submit}
      >
        {busy === 'creating' ? t('operatorSubmitting') : t('operatorSubmit')}
      </button>
    {:else}
      <button class="btn is-primary" type="button" onclick={close}>{t('close')}</button>
    {/if}
  {/snippet}
</Dialog>
