<script lang="ts">
  import { tick } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { storyCreate, storyUpdate, type StoryDetail } from '../../shared/operations/story/index.ts';
  import {
    LINK_URL_MAX_LENGTH,
    STORY_TEXT_MAX_LENGTH,
    STORY_TITLE_MAX_LENGTH,
    linkUrlProblem,
    longTextProblem,
    normalizeLinkUrl,
    normalizeLongText,
    storyTitleProblem,
    type StoryTitleProblem,
  } from '../../shared/story.ts';
  import { callOperation } from '../api.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // ストーリーのダイアログ。作るときも直すときも同じ欄（タイトル、受け入れ基準、本文、期日、リンク）で、タイトル以外は空でよい。
  // 直すときは、開いたときの値と比べて、変えた欄だけを送る（別の人が別の欄を直していれば両方が残り、同じ欄は後の保存が勝つ）。
  // 変えた欄が無ければ、何も送らずに閉じる。閉じたワークスペース（canWrite が偽）では読み取り専用で開き、保存のボタンを出さない。
  // 送っている間の扱いと、古い応答を捨てる generation は TaskCreateDialog と同じ。
  // 作れたら、保存できたら閉じて、画面が木を読み直す（onsaved）。本文と受け入れ基準は、この版では文字のまま持つ
  let {
    slug,
    workspaceId,
    canWrite,
    onsaved,
  }: { slug: string; workspaceId: string; canWrite: boolean; onsaved: () => void } = $props();

  const ids = $props.id();
  const formId = `${ids}-form`;
  const fieldIds = {
    title: `${ids}-title`,
    acceptance: `${ids}-acceptance`,
    body: `${ids}-body`,
    due: `${ids}-due`,
    link: `${ids}-link`,
  } as const;

  type FieldName = keyof typeof fieldIds;

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let submitButton = $state<HTMLButtonElement>();

  // null のとき作る。開いたときのストーリーを持つとき直す
  let editing = $state<StoryDetail | null>(null);
  let title = $state('');
  let acceptance = $state('');
  let body = $state('');
  let dueOn = $state('');
  let link = $state('');
  let errors = $state<Partial<Record<FieldName, string>>>({});
  let submitError = $state<string | null>(null);
  let submitting = $state(false);

  // 開き直しと部品の取り外しで進める。古い応答が、今の状態を上書きしない
  let generation = 0;

  // 閉じたと分かったら、ダイアログを閉じたときに画面を読み直す（すぐ読み直すと理由の文を読めなくなる）
  let reloadOnClose = false;
  $effect(() => {
    if (open || !reloadOnClose) return;
    reloadOnClose = false;
    void invalidateAll();
  });

  const currentWorkspaceId = $derived(workspaceId);
  $effect(() => {
    void currentWorkspaceId;
    return () => {
      generation++;
      submitting = false;
      open = false;
    };
  });

  export function show(trigger?: HTMLElement | null, story: StoryDetail | null = null): void {
    generation++;
    reloadOnClose = false;
    editing = story;
    title = story?.title ?? '';
    acceptance = story?.acceptance_criteria_md ?? '';
    body = story?.body_md ?? '';
    dueOn = story?.due_on ?? '';
    link = story?.link_url ?? '';
    errors = {};
    submitError = null;
    submitting = false;
    dialog?.show(trigger);
  }

  const readOnly = $derived(!canWrite);

  const titleMessages = $derived<Record<StoryTitleProblem, string>>({
    required: t('taskTitleRequired'),
    too_long: t('taskTitleTooLong', { max: STORY_TITLE_MAX_LENGTH }),
    invalid_character: t('taskTitleInvalidCharacter'),
  });

  function textProblemMessage(raw: string, field: string): string | null {
    const value = normalizeLongText(raw);
    const problem = value === null ? null : longTextProblem(value);
    if (problem === 'too_long') return t('fieldTextTooLong', { field, max: STORY_TEXT_MAX_LENGTH });
    if (problem === 'invalid_character') return t('fieldTextInvalidCharacter', { field });
    return null;
  }

  function linkProblemMessage(raw: string): string | null {
    const value = normalizeLinkUrl(raw);
    const problem = value === null ? null : linkUrlProblem(value);
    if (problem === 'too_long') return t('linkTooLong', { max: LINK_URL_MAX_LENGTH });
    if (problem === 'invalid_url') return t('linkInvalid');
    return null;
  }

  // 検査の結果。先頭のエラーの欄へフォーカスを移すため、画面の上から順に並べる
  function validate(): Partial<Record<FieldName, string>> {
    const found: Partial<Record<FieldName, string>> = {};
    const titleProblem = storyTitleProblem(title.trim());
    if (titleProblem !== null) found.title = titleMessages[titleProblem];
    const acceptanceMessage = textProblemMessage(acceptance, t('ac'));
    if (acceptanceMessage !== null) found.acceptance = acceptanceMessage;
    const bodyMessage = textProblemMessage(body, t('fieldBody'));
    if (bodyMessage !== null) found.body = bodyMessage;
    const linkMessage = linkProblemMessage(link);
    if (linkMessage !== null) found.link = linkMessage;
    return found;
  }

  // 開いたときの値と比べて、変えた欄だけ。空の欄は null にそろえて比べる
  function changedFields() {
    const original = editing;
    const next = {
      title: title.trim(),
      acceptance_criteria_md: normalizeLongText(acceptance),
      body_md: normalizeLongText(body),
      due_on: dueOn === '' ? null : dueOn,
      link_url: normalizeLinkUrl(link),
    };
    if (original === null) return next;
    const changed: Partial<typeof next> = {};
    if (next.title !== original.title) changed.title = next.title;
    if (next.acceptance_criteria_md !== original.acceptance_criteria_md)
      changed.acceptance_criteria_md = next.acceptance_criteria_md;
    if (next.body_md !== original.body_md) changed.body_md = next.body_md;
    if (next.due_on !== original.due_on) changed.due_on = next.due_on;
    if (next.link_url !== original.link_url) changed.link_url = next.link_url;
    return changed;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting || readOnly) return;
    errors = validate();
    const firstInvalid = (Object.keys(fieldIds) as FieldName[]).find((name) => errors[name] !== undefined);
    if (firstInvalid !== undefined) {
      document.getElementById(fieldIds[firstInvalid])?.focus();
      return;
    }
    const fields = changedFields();
    if (editing !== null && Object.keys(fields).length === 0) {
      open = false;
      return;
    }

    const mine = generation;
    submitting = true;
    submitError = null;
    // 欄が disabled になるので、Enter で送ったときもフォーカスを失わないよう、送るボタンへ移す
    submitButton?.focus();
    let focusTitle = false;
    try {
      const result =
        editing === null
          ? await callOperation(
              storyCreate,
              { workspace_id: workspaceId, ...(fields as Required<typeof fields>) },
              { slug },
            )
          : await callOperation(storyUpdate, { workspace_id: workspaceId, story_id: editing.id, ...fields }, { slug });
      if (mine !== generation) return;
      if (!result.ok) {
        if (result.status === 401) {
          await invalidateAll();
          return;
        }
        if (result.status === 409 && result.error?.code === 'workspace_closed') {
          submitError = t('workspaceClosedReadOnly', { workspace: t('workspace') });
          reloadOnClose = true;
        } else if (result.status === 404 && editing !== null) {
          // ストーリーが消えている。閉じて、木を読み直す
          open = false;
          showToast(t('storyGone', { story: t('story') }), 'alert');
          await invalidateAll();
        } else if (result.status === 400) {
          // 画面の検査を通った後に断られたのは、文字の決まり。どの欄かは分からないのでタイトルで知らせる
          errors = { title: t('taskTitleInvalidCharacter') };
          focusTitle = true;
        } else {
          submitError = editing === null ? t('taskCreateFailed') : t('storySaveFailed');
        }
        return;
      }
      const created = editing === null;
      open = false;
      showToast(t(created ? 'storyCreated' : 'storySaved', { story: t('story') }), 'check');
      onsaved();
    } finally {
      if (mine === generation) {
        submitting = false;
        if (focusTitle) {
          await tick();
          document.getElementById(fieldIds.title)?.focus();
        }
      }
    }
  }

  const status = $derived(submitting ? (editing === null ? t('taskSubmitting') : t('storySaving')) : '');
  const dialogTitle = $derived(editing === null ? t('storyCreate', { story: t('story') }) : t('story'));
</script>

{#snippet error(name: FieldName)}
  {#if errors[name] !== undefined}
    <span class="field-error" id="{fieldIds[name]}-error" role="alert"><Icon name="alert" />{errors[name]}</span>
  {/if}
{/snippet}

<Dialog bind:this={dialog} bind:open dismissible={!submitting} title={dialogTitle}>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    <fieldset class="form-fields" disabled={submitting}>
      {#if readOnly}
        <div class="callout is-info">
          <Icon name="alert" /><span>{t('storyReadOnly', { workspace: t('workspace'), story: t('story') })}</span>
        </div>
      {/if}

      <div class="field" class:is-invalid={errors.title !== undefined}>
        <label class="field-label" for={fieldIds.title}>{t('fieldTitle')}</label>
        <input
          class="input"
          id={fieldIds.title}
          bind:value={title}
          oninput={() => (errors.title = undefined)}
          placeholder={t('storyTitlePlaceholder')}
          autocomplete="off"
          readonly={readOnly}
          aria-invalid={errors.title !== undefined}
          aria-describedby={errors.title !== undefined ? `${fieldIds.title}-error` : undefined}
        />
        {@render error('title')}
      </div>

      <div class="field" class:is-invalid={errors.acceptance !== undefined}>
        <label class="field-label" for={fieldIds.acceptance}>{t('ac')}</label>
        <textarea
          class="textarea"
          id={fieldIds.acceptance}
          bind:value={acceptance}
          oninput={() => (errors.acceptance = undefined)}
          readonly={readOnly}
          aria-invalid={errors.acceptance !== undefined}
          aria-describedby={errors.acceptance !== undefined ? `${fieldIds.acceptance}-error` : undefined}></textarea>
        {@render error('acceptance')}
      </div>

      <div class="field" class:is-invalid={errors.body !== undefined}>
        <label class="field-label" for={fieldIds.body}>{t('fieldBody')}</label>
        <textarea
          class="textarea"
          id={fieldIds.body}
          bind:value={body}
          oninput={() => (errors.body = undefined)}
          readonly={readOnly}
          aria-invalid={errors.body !== undefined}
          aria-describedby={errors.body !== undefined ? `${fieldIds.body}-error` : undefined}></textarea>
        {@render error('body')}
      </div>

      <div class="form-row">
        <div class="field">
          <label class="field-label" for={fieldIds.due}>{t('due')}</label>
          <!-- 日付の入力は readonly を受けないので、読み取り専用のときは disabled にする -->
          <input class="input" id={fieldIds.due} type="date" bind:value={dueOn} disabled={readOnly} />
        </div>
        <div class="field" class:is-invalid={errors.link !== undefined}>
          <label class="field-label" for={fieldIds.link}>{t('fieldLink')}</label>
          <input
            class="input"
            id={fieldIds.link}
            type="url"
            bind:value={link}
            oninput={() => (errors.link = undefined)}
            placeholder={t('linkPlaceholder')}
            autocomplete="off"
            readonly={readOnly}
            aria-invalid={errors.link !== undefined}
            aria-describedby={errors.link !== undefined ? `${fieldIds.link}-error` : undefined}
          />
          {@render error('link')}
        </div>
      </div>
    </fieldset>

    {#if submitError !== null}
      <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{submitError}</span></div>
    {/if}
  </form>
  <!-- 状態の読み上げの領域。form の外に常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{status}</span>
  {#snippet footer(close)}
    {#if readOnly}
      <button class="btn is-primary" type="button" onclick={close}>{t('close')}</button>
    {:else}
      <button class="btn is-quiet" type="button" aria-disabled={submitting} onclick={close}>{t('cancel')}</button>
      <button class="btn is-primary" type="submit" form={formId} aria-disabled={submitting} bind:this={submitButton}>
        {submitting ? status : editing === null ? t('workspaceSubmit') : t('storySave')}
      </button>
    {/if}
  {/snippet}
</Dialog>
