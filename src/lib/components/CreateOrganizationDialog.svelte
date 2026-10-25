<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { callOperation, type ApiResult } from '../api.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import { slugProblem } from '../../shared/organization-slug.ts';
  import { createOrganization, resolveGithubUser } from '../../shared/operations/operator/index.ts';
  import type { DictionaryKey } from '../../shared/vocabulary.ts';
  import Avatar from './Avatar.svelte';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // design/kit.js の createOrganization。運用者が組織を作るダイアログ。
  // 順は、slug と表示名を入れ、最初の管理者のログインの手段を選び、GitHub のユーザー名を解決して指名する人（アバター、
  // ユーザー名、表示名）を見て確かめ、作る。打ち間違いで別の人を管理者にしないため、確かめるまで作れない。
  // 作るときは確かめたユーザー ID を渡し、サーバーが解決し直して違えば断る。作った後は、同じダイアログを完了の表示に切り替え、
  // 組織の URL（コピーできる）と、管理者になる人に伝えることを出す
  let { open = $bindable(false) }: { open?: boolean } = $props();

  type Resolved = {
    username: string;
    loginSubject: string;
    loginName: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  type Created = { slug: string; name: string; adminLoginName: string };
  type Field = 'slug' | 'name' | 'username' | 'form';

  let dialog = $state<ReturnType<typeof Dialog>>();
  let slug = $state('');
  let name = $state('');
  let via = $state<'github' | 'google'>('github');
  let username = $state('');
  let resolved = $state<Resolved | null>(null);
  let created = $state<Created | null>(null);
  let busy = $state<'idle' | 'resolving' | 'creating'>('idle');
  let errors = $state<Partial<Record<Field, DictionaryKey>>>({});
  let urlInput = $state<HTMLInputElement>();

  const words = $derived({ organization: t('organization'), admin: t('admin') });
  const organizationUrl = $derived(created === null ? '' : `${page.url.origin}/${created.slug}/`);
  const github = $derived(via === 'github');

  export function show(trigger?: HTMLElement | null): void {
    dialog?.show(trigger);
  }

  // 閉じたら入力を捨てる。作り終えた後の閉じ方も、途中でやめる閉じ方も同じ
  $effect(() => {
    if (open) return;
    slug = '';
    name = '';
    via = 'github';
    username = '';
    resolved = null;
    created = null;
    busy = 'idle';
    errors = {};
  });

  // 完了の表示に切り替わったら、フォーカスを消えたボタンから URL に移す
  $effect(() => {
    if (created !== null) urlInput?.focus();
  });

  // 入力の誤りの理由（details の code）を、辞書のキーに写す
  const problemKeys: Record<string, DictionaryKey> = {
    slug_format: 'operatorErrorSlugFormat',
    slug_reserved: 'operatorErrorSlugReserved',
    github_user_not_found: 'operatorErrorUserNotFound',
    github_not_a_user: 'operatorErrorNotUser',
    github_user_changed: 'operatorErrorUserChanged',
  };

  function problemCodes(result: Extract<ApiResult<unknown>, { ok: false }>): string[] {
    const details = result.error?.details;
    if (!Array.isArray(details)) return [];
    return details.flatMap((item: unknown) =>
      typeof item === 'object' && item !== null && 'code' in item && typeof item.code === 'string' ? [item.code] : [],
    );
  }

  type Failure = { field: Field; key: DictionaryKey; code?: string };

  // 失敗を、どの欄にどの文言を出すかに写す。ログインが切れた、運用者でなくなった人は、画面ごと移す。
  // context は、ユーザー名を確かめる（verify）か、作る（create）か
  function failureOf(result: Extract<ApiResult<unknown>, { ok: false }>, context: 'verify' | 'create'): Failure {
    if (isUnauthenticated(result)) window.location.assign(loginUrl(page.url));
    else if (result.status === 403) window.location.assign('/');
    const code = problemCodes(result)[0];
    if (code !== undefined && code in problemKeys) {
      return { field: code.startsWith('slug_') ? 'slug' : 'username', key: problemKeys[code]!, code };
    }
    if (result.status === 409) return { field: 'slug', key: 'operatorErrorSlugTaken' };
    // GitHub に届かないのは、組織を作る前（解決の段）。何も書かれていない
    if (result.status === 503) {
      return { field: context === 'verify' ? 'username' : 'form', key: 'operatorErrorGithubUnavailable' };
    }
    if (context === 'verify') return { field: 'username', key: 'operatorErrorUnreachable' };
    return { field: 'form', key: result.status === 0 ? 'operatorErrorUnreachable' : 'operatorErrorCreate' };
  }

  function changeVia(): void {
    resolved = null;
    errors = {};
  }

  // ユーザー名を直したら、確かめた結果は捨てる（確かめた人と違う人を指名しないため）
  function changeUsername(): void {
    resolved = null;
    errors = { ...errors, username: undefined };
  }

  async function verify(): Promise<void> {
    if (busy !== 'idle' || !github) return;
    const value = username.trim();
    if (value === '') {
      errors = { ...errors, username: 'operatorErrorUserRequired' };
      return;
    }
    errors = { ...errors, username: undefined, form: undefined };
    busy = 'resolving';
    const result = await callOperation(resolveGithubUser, { username: value });
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
  }

  // 作る前の確かめ。サーバーも同じ確かめをする（ここは入力の誤りをすぐ知らせるため）
  function validate(): boolean {
    const next: Partial<Record<Field, DictionaryKey>> = {};
    const trimmed = slug.trim();
    const problem = trimmed === '' ? undefined : slugProblem(trimmed);
    if (trimmed === '') next.slug = 'operatorErrorSlugRequired';
    else if (problem === 'format') next.slug = 'operatorErrorSlugFormat';
    else if (problem === 'reserved') next.slug = 'operatorErrorSlugReserved';
    if (name.trim() === '') next.name = 'operatorErrorNameRequired';
    errors = next;
    return Object.keys(next).length === 0;
  }

  async function submit(): Promise<void> {
    if (busy !== 'idle' || resolved === null || !validate()) return;
    busy = 'creating';
    const result = await callOperation(createOrganization, {
      slug: slug.trim(),
      name: name.trim(),
      admin: { provider: 'github', username: resolved.username, login_subject: resolved.loginSubject },
    });
    if (result.ok) {
      created = { slug: result.data.slug, name: result.data.name, adminLoginName: result.data.admin_login_name };
      busy = 'idle';
      await invalidateAll();
      return;
    }
    const failure = failureOf(result, 'create');
    if (failure.code === 'github_user_changed') resolved = null;
    errors = { [failure.field]: failure.key };
    busy = 'idle';
    // 500 や通信の失敗は、組織だけ作れて管理者を書けなかった場合がある。一覧で分かるよう読み直す
    if (result.status === 0 || (result.status >= 500 && result.status !== 503)) await invalidateAll();
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

<Dialog bind:this={dialog} bind:open title={t(created === null ? 'operatorCreateTitle' : 'operatorDoneTitle', words)}>
  {#if created === null}
    <div class="field" class:is-invalid={errors.slug}>
      <label class="field-label" for="operator-slug">{t('operatorSlugLabel')}</label>
      <input
        class="input mono"
        id="operator-slug"
        bind:value={slug}
        placeholder={t('operatorSlugExample')}
        autocomplete="off"
        spellcheck="false"
        aria-invalid={errors.slug ? 'true' : undefined}
        aria-describedby="operator-slug-hint"
        oninput={() => (errors = { ...errors, slug: undefined })}
      />
      {#if errors.slug}
        <span class="field-error" role="alert"><Icon name="alert" />{t(errors.slug)}</span>
      {/if}
      <span class="field-hint" id="operator-slug-hint">{t('operatorSlugHint')}</span>
    </div>
    <div class="field" class:is-invalid={errors.name}>
      <label class="field-label" for="operator-name">{t('operatorNameLabel')}</label>
      <input
        class="input"
        id="operator-name"
        bind:value={name}
        placeholder={t('operatorNameExample')}
        autocomplete="off"
        aria-invalid={errors.name ? 'true' : undefined}
        oninput={() => (errors = { ...errors, name: undefined })}
      />
      {#if errors.name}
        <span class="field-error" role="alert"><Icon name="alert" />{t(errors.name)}</span>
      {/if}
    </div>
    <div class="field">
      <span class="field-label" id="operator-via-label">{t('operatorAdminVia', words)}</span>
      <div class="segmented" role="radiogroup" aria-labelledby="operator-via-label">
        <label>
          <input type="radio" name="operator-via" value="github" bind:group={via} onchange={changeVia} />
          <span>{t('operatorGithubName')}</span>
        </label>
        <label>
          <input type="radio" name="operator-via" value="google" bind:group={via} onchange={changeVia} />
          <span>{t('operatorGoogleName')}</span>
        </label>
      </div>
    </div>
    {#if github}
      <div class="form-row">
        <div class="field" class:is-invalid={errors.username}>
          <label class="field-label" for="operator-username">{t('operatorGithubUserLabel')}</label>
          <input
            class="input mono"
            id="operator-username"
            bind:value={username}
            placeholder={t('operatorGithubUserExample')}
            autocomplete="off"
            spellcheck="false"
            aria-invalid={errors.username ? 'true' : undefined}
            oninput={changeUsername}
            onkeydown={(event) => {
              if (event.key === 'Enter' && !event.isComposing) {
                event.preventDefault();
                void verify();
              }
            }}
          />
          {#if errors.username}
            <span class="field-error" role="alert"><Icon name="alert" />{t(errors.username)}</span>
          {:else}
            <span class="field-hint">{t('operatorGithubUserHint')}</span>
          {/if}
        </div>
        <button class="btn" type="button" aria-disabled={busy !== 'idle'} onclick={verify}>
          {busy === 'resolving' ? t('operatorVerifying') : t('operatorVerify')}
        </button>
      </div>
      {#if resolved}
        <div class="callout is-info" role="status">
          <Icon name="shield" /><span>{t('operatorVerifyLead', words)}</span>
        </div>
        <div class="choice is-static">
          <Avatar userId={resolved.loginSubject} name={resolved.loginName} image={resolved.avatarUrl} large />
          <div>
            <b>{resolved.displayName ?? t('operatorNoDisplayName')}</b>
            <span class="mono">{resolved.loginName}</span>
            <span>{t('operatorGithubId', { id: resolved.loginSubject })}</span>
          </div>
        </div>
      {/if}
    {:else}
      <div class="callout is-warn" role="status"><Icon name="alert" /><span>{t('operatorGoogleSoon')}</span></div>
    {/if}
    {#if errors.form}
      <div class="callout is-warn" role="alert"><Icon name="alert" /><span>{t(errors.form, words)}</span></div>
    {/if}
  {:else}
    <p>{t('operatorDoneLead', words)}</p>
    <div class="form-row">
      <div class="field">
        <label class="field-label" for="operator-url">{t('operatorDoneUrlLabel', words)}</label>
        <input class="input mono" id="operator-url" value={organizationUrl} readonly bind:this={urlInput} />
      </div>
      <button class="btn" type="button" onclick={copyUrl}><Icon name="link" />{t('operatorCopy')}</button>
    </div>
    <div class="callout is-info">
      <Icon name="check" /><span>{t('operatorDoneTell', { name: created.adminLoginName })}</span>
    </div>
  {/if}
  {#snippet footer(close)}
    {#if created === null}
      <button class="btn is-quiet" type="button" onclick={close}>{t('operatorCancel')}</button>
      <button
        class="btn is-primary"
        type="button"
        disabled={busy !== 'idle' || resolved === null || !github}
        onclick={submit}
      >
        {busy === 'creating' ? t('operatorSubmitting') : t('operatorSubmit')}
      </button>
    {:else}
      <button class="btn is-primary" type="button" onclick={close}>{t('close')}</button>
    {/if}
  {/snippet}
</Dialog>
