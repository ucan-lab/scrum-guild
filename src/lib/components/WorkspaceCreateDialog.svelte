<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { workspaceCreate, workspaceLeaderCandidates } from '../../shared/operations/workspace/index.ts';
  import type { Vocabulary } from '../../shared/vocabulary.ts';
  import {
    DEFAULT_HOURS_PER_POINT,
    WORKSPACE_NAME_MAX_LENGTH,
    defaultColumnNames,
    defaultDetailFieldNames,
  } from '../../shared/workspace.ts';
  import { callOperation } from '../api.ts';
  import { browserTimezone } from '../format.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t, tIn } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // admin.html / kit.js の createWorkspace。管理の画面と自分の今日の2か所が、同じ部品を使う。
  // 開いたときに最初のリーダーの候補を取る（既定は自分）。言葉づかいの既定は組織の言葉づかい。
  // 説明文には、選んだ言葉づかいの列と決まった欄の名前、換算比率、週の始まり、このブラウザのタイムゾーンを出す。
  // 送っている間は「作る」を押せない（二重送信はそれだけで防ぐ）。作れたら組織の枠のデータを読み直し、そのワークスペースの画面へ移る
  let { slug, meId, organizationVocabulary }: { slug: string; meId: string; organizationVocabulary: Vocabulary } =
    $props();

  type Candidate = { id: string; name: string };

  const ids = $props.id();
  const formId = `${ids}-form`;
  const nameId = `${ids}-name`;
  const nameErrorId = `${ids}-name-error`;
  const leaderId = `${ids}-leader`;
  const vocabularyLabelId = `${ids}-vocabulary`;

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let nameInput = $state<HTMLInputElement>();

  let name = $state('');
  let leaderUserId = $state('');
  let vocabulary = $state<Vocabulary>('game');
  let candidates = $state<Candidate[]>([]);
  let candidatesState = $state<'loading' | 'failed' | 'ready'>('loading');
  let nameError = $state<string | null>(null);
  let submitError = $state<string | null>(null);
  let submitting = $state(false);

  const timezone = browserTimezone();
  // 古い読み込みの結果で、開き直した後の状態を上書きしない
  let loadSequence = 0;

  export function show(trigger?: HTMLElement | null): void {
    name = '';
    vocabulary = organizationVocabulary;
    leaderUserId = meId;
    nameError = null;
    submitError = null;
    dialog?.show(trigger);
    void loadCandidates();
  }

  async function loadCandidates(): Promise<void> {
    const sequence = ++loadSequence;
    candidatesState = 'loading';
    const result = await callOperation(workspaceLeaderCandidates, {}, { slug });
    if (sequence !== loadSequence) return;
    if (!result.ok) {
      candidatesState = 'failed';
      return;
    }
    candidates = result.data.users;
    // 自分が候補にいれば自分。いなければ先頭
    if (!candidates.some((user) => user.id === leaderUserId)) leaderUserId = candidates[0]?.id ?? '';
    candidatesState = 'ready';
  }

  const words = $derived({ workspace: vocabulary });
  const defaultsNote = $derived(
    tIn('workspaceDefaultsNote', words, {
      column: tIn('column', words),
      columns: [...defaultColumnNames[vocabulary], tIn('done', words)].join('、'),
      field: defaultDetailFieldNames[vocabulary],
      points: tIn('points', words),
      hours: DEFAULT_HOURS_PER_POINT,
      timezone,
    }),
  );

  function validateName(): string | null {
    const trimmed = name.trim();
    if (trimmed === '') return t('workspaceNameRequired');
    if (trimmed.length > WORKSPACE_NAME_MAX_LENGTH)
      return t('workspaceNameTooLong', { max: WORKSPACE_NAME_MAX_LENGTH });
    return null;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting || candidatesState !== 'ready' || leaderUserId === '') return;
    nameError = validateName();
    if (nameError !== null) {
      nameInput?.focus();
      return;
    }
    submitting = true;
    submitError = null;
    const result = await callOperation(
      workspaceCreate,
      { name: name.trim(), timezone, vocabulary, leader_user_id: leaderUserId },
      { slug },
    );
    if (!result.ok) {
      submitting = false;
      if (result.status === 401) {
        // セッションが切れた。組織の枠の読み直しがログインの画面へ移す
        await invalidateAll();
        return;
      }
      if (result.status === 404) {
        submitError = t('workspaceLeaderRejected', { leader: t('leader') });
        // 候補を取り直して、選び直せるようにする
        void loadCandidates();
      } else {
        submitError = t('workspaceCreateFailed');
      }
      return;
    }
    // 組織の枠のデータ（has_workspaces、所属するワークスペース）を読み直してから移る
    await invalidateAll();
    open = false;
    await goto(resolve('/[slug]/w/[id]', { slug, id: result.data.workspace_id }));
    showToast(t('workspaceCreated', { workspace: tIn('workspace', words) }), 'check');
    submitting = false;
  }
</script>

<Dialog bind:this={dialog} bind:open title={t('workspaceCreateAction', { workspace: t('workspace') })}>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    <div class="field" class:is-invalid={nameError !== null}>
      <label class="field-label" for={nameId}>{t('fieldName')}</label>
      <input
        class="input"
        id={nameId}
        bind:this={nameInput}
        bind:value={name}
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
      <label class="field-label" for={leaderId}>{t('workspaceLeaderLabel', { leader: t('leader') })}</label>
      {#if candidatesState === 'failed'}
        <span class="field-error" role="alert"><Icon name="alert" />{t('workspaceLeaderLoadFailed')}</span>
        <div class="form-actions">
          <button class="btn is-sm" type="button" onclick={loadCandidates}>{t('retry')}</button>
        </div>
      {:else}
        <select class="select" id={leaderId} bind:value={leaderUserId} disabled={candidatesState === 'loading'}>
          {#if candidatesState === 'loading'}
            <option value="">{t('loading')}</option>
          {:else}
            {#each candidates as user (user.id)}
              <option value={user.id}>{user.name}</option>
            {/each}
          {/if}
        </select>
        <span class="field-hint">{t('workspaceLeaderHint', { leader: t('leader') })}</span>
      {/if}
    </div>

    <div class="field">
      <span class="field-label" id={vocabularyLabelId}>{t('workspaceVocabularyLabel')}</span>
      <div class="choice-list" role="radiogroup" aria-labelledby={vocabularyLabelId}>
        <label class="choice">
          <input type="radio" name="{ids}-vocabulary" value="game" bind:group={vocabulary} />
          <div><b>{t('vocabularyGameLabel')}</b><span>{t('vocabularyGameNote')}</span></div>
        </label>
        <label class="choice">
          <input type="radio" name="{ids}-vocabulary" value="scrum" bind:group={vocabulary} />
          <div><b>{t('vocabularyScrumLabel')}</b><span>{t('vocabularyScrumNote')}</span></div>
        </label>
      </div>
      <span class="field-hint">{t('workspaceVocabularyHint')}</span>
    </div>

    <p class="field-hint">{defaultsNote}</p>

    {#if submitError !== null}
      <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{submitError}</span></div>
    {/if}
  </form>
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" onclick={close}>{t('cancel')}</button>
    <button
      class="btn is-primary"
      type="submit"
      form={formId}
      disabled={submitting || candidatesState !== 'ready' || leaderUserId === ''}
    >
      {submitting ? t('workspaceSubmitting') : t('workspaceSubmit')}
    </button>
  {/snippet}
</Dialog>
