<script lang="ts">
  import { tick } from 'svelte';
  import { goto, invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { workspaceCreate, workspaceLeaderCandidates } from '../../shared/operations/workspace/index.ts';
  import {
    DEFAULT_HOURS_PER_POINT,
    WORKSPACE_NAME_MAX_LENGTH,
    defaultColumnNames,
    defaultDetailFieldName,
    workspaceNameProblem,
    type WorkspaceNameProblem,
  } from '../../shared/workspace.ts';
  import { callOperation } from '../api.ts';
  import { browserTimezone } from '../format.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // admin.html / kit.js の createWorkspace。管理の画面と今日やることの2か所が、同じ部品を使う。
  // 開いたときに最初のリーダーの候補を取る（既定は自分）。説明文には、列と決まった欄の名前、換算比率、
  // 週の始まり、このブラウザのタイムゾーンを出す。
  // 送っている間は、「作る」を押しても無視し（aria-disabled）、ダイアログも閉じられない。二重送信はそれだけで防ぐ。
  // 作れたら、同じダイアログの中身を完了の表示（見出し「ワークスペースを作りました」、作った名前、「続けて作る」「開く」）に
  // 差し替える（開き直さないので、フォーカスの閉じ込めと戻し先は途切れない）。作れた時点で組織の枠のデータを読み直し
  // （読み直しが失敗しても完了の表示は出す）、oncreated で画面に知らせる（管理の画面は一覧を読み直す）。
  // 「続けて作る」は開いたときと同じ空のフォームに戻して名前の欄へ、「開く」は閉じてそのワークスペースの画面へ移り見出しにフォーカスを置く。
  // 完了の表示を×、Esc、背景で閉じたら、今の画面に残る。
  // 送り始めた後に部品が外れた（画面を離れた、組織が替わった）ときは、古い応答で完了の表示にせず、状態も更新しない（generation）
  let { slug, meId, oncreated }: { slug: string; meId: string; oncreated?: (workspaceId: string) => void } = $props();

  type Candidate = { id: string; name: string };

  const ids = $props.id();
  const formId = `${ids}-form`;
  const nameId = `${ids}-name`;
  const nameErrorId = `${ids}-name-error`;
  const leaderId = `${ids}-leader`;
  const leaderHintId = `${ids}-leader-hint`;
  const leaderStateId = `${ids}-leader-state`;

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let nameInput = $state<HTMLInputElement>();
  let leaderSelect = $state<HTMLSelectElement>();
  let submitButton = $state<HTMLButtonElement>();

  let name = $state('');
  let leaderUserId = $state('');
  let candidates = $state<Candidate[]>([]);
  let candidatesState = $state<'loading' | 'failed' | 'ready'>('loading');
  // 読み込みに失敗したことがある間は、読み直している最中も「もう一度試す」を残す（フォーカスを失わせない）
  let candidatesFailedBefore = $state(false);
  let nameError = $state<string | null>(null);
  let submitError = $state<string | null>(null);
  let submitting = $state(false);
  // 作れたワークスペース。あれば完了の表示。組織は送り始めたときのもの
  let created = $state<{ id: string; name: string; slug: string } | null>(null);
  let openButton = $state<HTMLButtonElement>();

  const timezone = browserTimezone();
  // 開き直し、部品の取り外し、組織の入れ替わりで進める。古い読み込みと古い応答が、今の状態を上書きしない
  let generation = 0;

  const canSubmit = $derived(!submitting && candidatesState === 'ready' && leaderUserId !== '');

  // 組織の枠のデータを読み直すと slug の props は新しい getter になるが、値が同じなら $derived は変わらない
  const currentSlug = $derived(slug);

  $effect(() => {
    void currentSlug;
    return () => {
      generation++;
      submitting = false;
      open = false;
    };
  });

  // 空の作成のフォームに戻す。開いたときと「続けて作る」が同じ状態から始める
  function resetForm(): void {
    generation++;
    name = '';
    nameError = null;
    submitError = null;
    submitting = false;
    created = null;
    candidatesFailedBefore = false;
    void loadCandidates();
  }

  export function show(trigger?: HTMLElement | null): void {
    resetForm();
    dialog?.show(trigger);
  }

  // 完了の表示から作成のフォームへ戻る。名前は空、リーダーは候補を取り直して自分、フォーカスは名前の欄
  async function createAnother(): Promise<void> {
    resetForm();
    await tick();
    nameInput?.focus();
  }

  // 閉じて、作ったワークスペースの画面へ移り、見出しにフォーカスを置く
  async function openCreated(): Promise<void> {
    if (created === null) return;
    const target = created;
    open = false;
    await goto(resolve('/[slug]/w/[id]', { slug: target.slug, id: target.id }), { refreshAll: true });
    // 移った先の見出しへフォーカスを置く（移った画面の題は、SvelteKit のルートの読み上げが伝える）
    await tick();
    document.querySelector<HTMLElement>('main h1')?.focus();
  }

  async function loadCandidates(): Promise<void> {
    const mine = generation;
    const targetSlug = slug;
    candidatesState = 'loading';
    leaderUserId = '';
    const result = await callOperation(workspaceLeaderCandidates, {}, { slug: targetSlug });
    if (mine !== generation) return;
    if (!result.ok) {
      candidatesState = 'failed';
      candidatesFailedBefore = true;
      return;
    }
    candidates = result.data.users;
    // 自分が候補にいれば自分。いなければ先頭。候補が無ければ空のまま
    leaderUserId = candidates.some((user) => user.id === meId) ? meId : (candidates[0]?.id ?? '');
    candidatesFailedBefore = false;
    candidatesState = 'ready';
  }

  // 読み直しに成功したら、選ぶ欄へフォーカスを移す（押したボタンは、成功すると消えるため）
  async function retryCandidates(): Promise<void> {
    if (candidatesState === 'loading') return;
    await loadCandidates();
    if (candidatesState !== 'ready') return;
    await tick();
    leaderSelect?.focus();
  }

  const nameMessages = $derived<Record<WorkspaceNameProblem, string>>({
    required: t('workspaceNameRequired'),
    too_long: t('workspaceNameTooLong', { max: WORKSPACE_NAME_MAX_LENGTH }),
    invalid_character: t('workspaceNameInvalidCharacter'),
  });

  function nameProblemMessage(): string | null {
    const problem = workspaceNameProblem(name.trim());
    return problem === null ? null : nameMessages[problem];
  }

  const leaderWord = t('leader');
  const defaultsNote = t('workspaceDefaultsNote', {
    column: t('column'),
    columns: [...defaultColumnNames, t('done')].join('、'),
    field: defaultDetailFieldName,
    points: t('points'),
    hours: DEFAULT_HOURS_PER_POINT,
    timezone,
  });

  // 400 の details（項目ごとの path）から、断られた項目を取り出す
  function rejectedFields(details: unknown): string[] {
    if (!Array.isArray(details)) return [];
    return details.flatMap((item: unknown) =>
      typeof item === 'object' && item !== null && 'path' in item && typeof item.path === 'string' ? [item.path] : [],
    );
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    nameError = nameProblemMessage();
    if (nameError !== null) {
      nameInput?.focus();
      return;
    }
    const mine = generation;
    // 送り始めたときの組織で、送ることも移ることも通す
    const targetSlug = slug;
    const sentTimezone = timezone;
    submitting = true;
    submitError = null;
    // 欄が disabled になるので、Enter で送ったときもフォーカスを失わないよう、「作る」へ移す
    submitButton?.focus();
    // 名前が断られたときに名前の欄へ戻す。送っている間は欄が disabled でフォーカスを受けないので、戻すのは disabled を外した後
    let focusName = false;
    try {
      const result = await callOperation(
        workspaceCreate,
        { name: name.trim(), timezone: sentTimezone, leader_user_id: leaderUserId },
        { slug: targetSlug },
      );
      if (mine !== generation) return;
      if (!result.ok) {
        if (result.status === 401) {
          // セッションが切れた。組織の枠の読み直しがログインの画面へ移す
          await invalidateAll();
          return;
        }
        if (result.status === 404) {
          submitError = t('workspaceLeaderRejected', { leader: leaderWord });
          // 候補を取り直して、選び直せるようにする
          void loadCandidates();
        } else if (result.status === 400 && rejectedFields(result.error?.details).includes('timezone')) {
          // ブラウザの値は直せない。理由を伝える
          submitError = t('workspaceTimezoneRejected', { timezone: sentTimezone });
        } else if (result.status === 400 && rejectedFields(result.error?.details).includes('name')) {
          nameError = t('workspaceNameInvalidCharacter');
          focusName = true;
        } else {
          submitError = t('workspaceCreateFailed');
        }
        return;
      }
      if (mine !== generation) return;
      created = { id: result.data.workspace_id, name: name.trim(), slug: targetSlug };
      oncreated?.(result.data.workspace_id);
      // 組織の枠のデータ（has_workspaces、所属するワークスペース）を読み直す。失敗しても完了の表示は出す
      void invalidateAll().catch(() => undefined);
      // 押した「作る」は消えるので、完了の表示の主ボタンへフォーカスを移す
      await tick();
      openButton?.focus();
    } finally {
      if (mine === generation) {
        submitting = false;
        if (focusName) {
          await tick();
          nameInput?.focus();
        }
      }
    }
  }

  // 状態を読み上げに伝える。領域は常に置き、中の文字だけを替える
  const status = $derived(
    created !== null
      ? t('workspaceCreated', { workspace: t('workspace') })
      : submitting
        ? t('workspaceSubmitting')
        : candidatesState === 'loading'
          ? t('loading')
          : '',
  );
</script>

<Dialog
  bind:this={dialog}
  bind:open
  dismissible={!submitting}
  title={created !== null
    ? t('workspaceCreated', { workspace: t('workspace') })
    : t('workspaceCreateAction', { workspace: t('workspace') })}
>
  {#if created !== null}
    <div class="callout is-ok"><Icon name="check" /><span class="wrap-anywhere">{created.name}</span></div>
  {:else}
    <form id={formId} class="form" onsubmit={submit} novalidate>
      <!-- 送っている間は、欄も変えられない。「作る」はフォーカスを残すため、欄のまとまりの外で aria-disabled にしている -->
      <fieldset class="form-fields" disabled={submitting}>
        <div class="field" class:is-invalid={nameError !== null}>
          <label class="field-label" for={nameId}>{t('fieldName')}</label>
          <input
            class="input"
            id={nameId}
            bind:this={nameInput}
            bind:value={name}
            oninput={() => (nameError = null)}
            placeholder={t('workspaceNamePlaceholder')}
            autocomplete="off"
            aria-invalid={nameError !== null}
            aria-describedby={nameError !== null ? nameErrorId : undefined}
          />
          {#if nameError !== null}
            <span class="field-error" id={nameErrorId} role="alert"><Icon name="alert" />{nameError}</span>
          {/if}
        </div>

        <div class="field">
          <label class="field-label" for={leaderId}>{t('workspaceLeaderLabel', { leader: leaderWord })}</label>
          <select
            class="select"
            id={leaderId}
            bind:this={leaderSelect}
            bind:value={leaderUserId}
            disabled={candidatesState !== 'ready' || candidates.length === 0}
            aria-busy={candidatesState === 'loading'}
            aria-describedby="{leaderHintId} {leaderStateId}"
          >
            {#if candidatesState === 'loading'}
              <option value="">{t('loading')}</option>
            {:else if candidatesState === 'failed' || candidates.length === 0}
              <!-- 理由の文は、下のエラー側だけに出す -->
              <option value="">&mdash;</option>
            {:else}
              {#each candidates as user (user.id)}
                <option value={user.id}>{user.name}</option>
              {/each}
            {/if}
          </select>
          <span class="field-hint" id={leaderHintId}>{t('workspaceLeaderHint', { leader: leaderWord })}</span>
          <!-- 候補を取れない、または0件のときは、「作る」を押せない理由をここに出す -->
          <span id={leaderStateId}>
            {#if candidatesState === 'failed'}
              <span class="field-error" role="alert"><Icon name="alert" />{t('workspaceLeaderLoadFailed')}</span>
            {:else if candidatesState === 'ready' && candidates.length === 0}
              <span class="field-error"><Icon name="alert" />{t('workspaceNoCandidates', { leader: leaderWord })}</span>
            {/if}
          </span>
          {#if candidatesFailedBefore}
            <div class="form-actions">
              <button
                class="btn is-sm"
                type="button"
                aria-disabled={candidatesState === 'loading'}
                onclick={retryCandidates}
              >
                {candidatesState === 'loading' ? t('retrying') : t('retry')}
              </button>
            </div>
          {/if}
        </div>

        <p class="field-hint">{defaultsNote}</p>
      </fieldset>

      {#if submitError !== null}
        <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{submitError}</span></div>
      {/if}
    </form>
  {/if}
  <!-- 状態の読み上げの領域。form の外に常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{status}</span>
  {#snippet footer(close)}
    {#if created !== null}
      <button class="btn is-quiet" type="button" onclick={createAnother}>{t('workspaceCreateAnother')}</button>
      <button class="btn is-primary" type="button" bind:this={openButton} onclick={openCreated}>
        {t('workspaceOpen')}
      </button>
    {:else}
      <button class="btn is-quiet" type="button" aria-disabled={submitting} onclick={close}>{t('cancel')}</button>
      <button class="btn is-primary" type="submit" form={formId} aria-disabled={!canSubmit} bind:this={submitButton}>
        {submitting ? t('workspaceSubmitting') : t('workspaceSubmit')}
      </button>
    {/if}
  {/snippet}
</Dialog>
