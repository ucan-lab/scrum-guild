<script lang="ts">
  import { tick } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { EPIC_TITLE_MAX_LENGTH, epicTitleProblem, type EpicTitleProblem } from '../../shared/epic.ts';
  import { epicCreate, epicGet, epicUpdate, type EpicDetail } from '../../shared/operations/epic/index.ts';
  import {
    LINK_URL_MAX_LENGTH,
    STORY_TEXT_MAX_LENGTH,
    canonicalLinkUrl,
    linkUrlProblem,
    longTextProblem,
    normalizeLinkUrl,
    normalizeLongText,
  } from '../../shared/story.ts';
  import type { DefinitionRef } from '../../shared/operations/definition/definition.ts';
  import { callOperation } from '../api.ts';
  import { withCurrent } from '../definition-options.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import TreeDeleteDialog from './TreeDeleteDialog.svelte';

  // エピックのダイアログ。作るときも直すときも同じ欄（タイトル、本文、期日、リンク）で、タイトル以外は空でよい。
  // 振る舞いは StoryDialog と同じ（欄に受け入れ基準が無いだけ）。直すときは、開いたら epic-get で1件を読み（本文は長いので、木には載せない）、
  // 開いたときの値と比べて変えた欄だけを送る。変えた欄が無ければ、何も送らずに閉じる。404 は、トーストで知らせて閉じ、画面が木を読み直す（ongone）。
  // 閉じたワークスペース（canWrite が偽）では読み取り専用で開き、保存のボタンを出さない。
  // 依頼主、クリア報酬、討伐隊、クリアと中止は、エピックの画面の Issue（#65）で足す。
  // 作れたら、保存できたら閉じて、画面が木を読み直す（onsaved）。本文は、この版では文字のまま持つ
  // 区分（categories から選ぶ。区分なしも選べる）は、配下のストーリーとタスクが引き継ぐ
  // 直すときは、欄の下に「この<エピック>を削除する」を置く（タスクの引き出しと同じ作り）。削除できない人（epic-get の can_delete が偽）には
  // 出さず、削除できる人を添える。押すと配下の扱いを選ぶ確認（TreeDeleteDialog）をこのダイアログの上に開き、削除できたら閉じて、
  // 画面が木を読み直す（ongone）
  let {
    slug,
    workspaceId,
    canWrite,
    categories,
    categoriesFailed,
    onsaved,
    ongone,
    announceCreated = true,
  }: {
    slug: string;
    workspaceId: string;
    canWrite: boolean;
    categories: readonly DefinitionRef[];
    // 区分の一覧を読めなかった（選択肢は区分なしと今の区分だけ）
    categoriesFailed: boolean;
    // 作ったときは作ったエピックの ID、直したときは null（画面が、作ったものが絞り込みに当たるかを確かめる）
    onsaved: (createdId: string | null) => void;
    // 直す対象が消えていた（404）か、削除した。画面が木を読み直し、見出しへフォーカスを移す
    ongone: () => void;
    // 偽なら作った知らせ（トースト）を出さない。絞り込み中の画面が、作ったものが当たるかを確かめてから自分で知らせる
    announceCreated?: boolean;
  } = $props();

  const ids = $props.id();
  const formId = `${ids}-form`;
  const fieldIds = {
    title: `${ids}-title`,
    body: `${ids}-body`,
    due: `${ids}-due`,
    link: `${ids}-link`,
  } as const;
  const categoryId = `${ids}-category`;

  type FieldName = keyof typeof fieldIds;

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let submitButton = $state<HTMLButtonElement>();
  let dueInput = $state<HTMLInputElement>();

  // 直すときの対象の ID。作るときは null
  let epicId = $state<string | null>(null);
  let loadState = $state<'loading' | 'ready' | 'failed'>('ready');
  let editing = $state<EpicDetail | null>(null);
  // 呼んだ人が削除できるか（作った人かリーダー）と、配下の件数。epic-get が返す
  let canDelete = $state(false);
  let childCounts = $state({ stories: 0, tasks: 0 });
  let canDeleteChildren = $state(false);
  let deleteDialog = $state<ReturnType<typeof TreeDeleteDialog>>();
  let title = $state('');
  let body = $state('');
  let dueOn = $state('');
  let link = $state('');
  // 選んだ区分の ID。空は区分なし
  let category = $state('');
  // 区分の選択肢。今の区分が一覧に無い（一覧を読めなかった、削除された）ときも、選んだまま描けるよう足す。
  // epic-get は区分の ID だけを返すので、名前の代わりに一覧を読めなかったことを出す
  const categoryOptions = $derived(
    withCurrent(
      categories,
      editing?.category_id == null
        ? null
        : { id: editing.category_id, name: t('categoryCurrentUnread', { category: t('category') }) },
    ),
  );
  const categoryName = $derived(
    categoryOptions.find((option) => option.id === category)?.name ?? t('categoryNone', { category: t('category') }),
  );
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

  function fill(epic: EpicDetail | null): void {
    editing = epic;
    title = epic?.title ?? '';
    body = epic?.body_md ?? '';
    dueOn = epic?.due_on ?? '';
    link = epic?.link_url ?? '';
    category = epic?.category_id ?? '';
  }

  async function load(id: string, mine: number): Promise<void> {
    loadState = 'loading';
    submitError = null;
    const result = await callOperation(epicGet, { workspace_id: workspaceId, epic_id: id }, { slug });
    if (mine !== generation) return;
    if (result.ok) {
      fill(result.data.epic);
      canDelete = result.data.can_delete;
      childCounts = result.data.children;
      canDeleteChildren = result.data.can_delete_children;
      loadState = 'ready';
      await tick();
      if (mine === generation) document.getElementById(fieldIds.title)?.focus();
      return;
    }
    if (result.status === 401) {
      await invalidateAll();
      return;
    }
    if (result.status === 404) {
      open = false;
      showToast(t('epicGone', { epic: t('epic') }), 'alert');
      ongone();
      return;
    }
    loadState = 'failed';
  }

  export function show(trigger?: HTMLElement | null, targetId: string | null = null): void {
    generation++;
    reloadOnClose = false;
    epicId = targetId;
    fill(null);
    canDelete = false;
    childCounts = { stories: 0, tasks: 0 };
    canDeleteChildren = false;
    errors = {};
    submitError = null;
    submitting = false;
    loadState = targetId === null ? 'ready' : 'loading';
    dialog?.show(trigger);
    if (targetId !== null) void load(targetId, generation);
  }

  const readOnly = $derived(!canWrite);

  const titleMessages = $derived<Record<EpicTitleProblem, string>>({
    required: t('epicTitleRequired'),
    too_long: t('epicTitleTooLong', { max: EPIC_TITLE_MAX_LENGTH }),
    invalid_character: t('epicTitleInvalidCharacter'),
  });

  function bodyProblemMessage(raw: string): string | null {
    const value = normalizeLongText(raw);
    const problem = value === null ? null : longTextProblem(value);
    const field = t('fieldBody');
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
    const titleProblem = epicTitleProblem(title.trim());
    if (titleProblem !== null) found.title = titleMessages[titleProblem];
    const bodyMessage = bodyProblemMessage(body);
    if (bodyMessage !== null) found.body = bodyMessage;
    if (dueInput?.validity.badInput) found.due = t('dueInvalid', { due: t('due') });
    const linkMessage = linkProblemMessage(link);
    if (linkMessage !== null) found.link = linkMessage;
    return found;
  }

  // 開いたときの値と比べて、変えた欄だけ。空の欄は null にそろえて比べる
  function changedFields() {
    const original = editing;
    const next = {
      title: title.trim(),
      body_md: normalizeLongText(body),
      due_on: dueOn === '' ? null : dueOn,
      link_url: normalizeLinkUrl(link),
      category_id: category === '' ? null : category,
    };
    if (original === null) return next;
    const changed: Partial<typeof next> = {};
    if (next.title !== original.title) changed.title = next.title;
    if (next.body_md !== original.body_md) changed.body_md = next.body_md;
    if (next.due_on !== original.due_on) changed.due_on = next.due_on;
    if (next.link_url !== original.link_url) changed.link_url = next.link_url;
    if (next.category_id !== original.category_id) changed.category_id = next.category_id;
    return changed;
  }

  // 404 の理由を分ける。作るとき（id が null）は、エピックはまだ無いので、区分が理由
  async function epicExists(id: string | null): Promise<boolean> {
    if (id === null) return true;
    const result = await callOperation(epicGet, { workspace_id: workspaceId, epic_id: id }, { slug });
    return result.ok;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting || readOnly || loadState !== 'ready') return;
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
    submitButton?.focus();
    try {
      const result =
        editing === null
          ? await callOperation(
              epicCreate,
              { workspace_id: workspaceId, ...(fields as Required<typeof fields>) },
              { slug },
            )
          : await callOperation(epicUpdate, { workspace_id: workspaceId, epic_id: editing.id, ...fields }, { slug });
      if (mine !== generation) return;
      if (!result.ok) {
        if (result.status === 401) {
          await invalidateAll();
          return;
        }
        if (result.status === 409 && result.error?.code === 'workspace_closed') {
          submitError = t('workspaceClosedReadOnly', { workspace: t('workspace') });
          reloadOnClose = true;
        } else if (result.status === 404 && fields.category_id != null && (await epicExists(editing?.id ?? null))) {
          // エピックはあるので、選んだ区分が削除されていた。一覧を読み直して、選び直してもらう
          if (mine !== generation) return;
          submitError = t('definitionRefGone', { kind: t('category') });
          category = '';
          void invalidateAll();
        } else if (result.status === 404 && editing !== null) {
          if (mine !== generation) return;
          open = false;
          showToast(t('epicGone', { epic: t('epic') }), 'alert');
          ongone();
        } else if (result.status === 400) {
          submitError = t('epicBadRequest');
        } else {
          submitError = editing === null ? t('epicCreateFailed') : t('epicSaveFailed');
        }
        return;
      }
      const created = editing === null;
      open = false;
      if (!created || announceCreated) {
        showToast(t(created ? 'epicCreated' : 'epicSaved', { epic: t('epic') }), 'check');
      }
      onsaved(created ? result.data.epic.id : null);
    } finally {
      if (mine === generation) submitting = false;
    }
  }

  // 削除の確認を開く。件数とまとめて削除できるかは、確認が開いたときに epic-get で読み直す（それまでは、このダイアログが読んだ値を出す）
  function askDelete(event: MouseEvent): void {
    if (editing === null || submitting) return;
    const trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    deleteDialog?.show(
      { kind: 'epic', id: editing.id, title: editing.title, ...childCounts, canDeleteChildren },
      trigger,
    );
  }

  function deleteFinished(outcome: 'deleted' | 'gone' | 'closed'): void {
    if (outcome === 'closed') {
      reloadOnClose = true;
      return;
    }
    open = false;
    if (outcome === 'deleted') showToast(t('epicDeleted', { epic: t('epic') }), 'check');
    else showToast(t('epicGone', { epic: t('epic') }), 'alert');
    ongone();
  }

  const status = $derived(
    loadState === 'loading'
      ? t('epicLoading')
      : submitting
        ? epicId === null
          ? t('epicCreating')
          : t('epicSaving')
        : '',
  );
  const dialogTitle = $derived(epicId === null ? t('epicCreate', { epic: t('epic') }) : t('epic'));
  // 「開く」で開けるのは、いま入っているリンクが使える URL のときだけ
  const openHref = $derived.by(() => {
    const value = normalizeLinkUrl(link);
    return value !== null && linkUrlProblem(value) === null ? canonicalLinkUrl(value) : null;
  });
</script>

{#snippet error(name: FieldName)}
  {#if errors[name] !== undefined}
    <span class="field-error" id="{fieldIds[name]}-error" role="alert"><Icon name="alert" />{errors[name]}</span>
  {/if}
{/snippet}

<Dialog bind:this={dialog} bind:open dismissible={!submitting} title={dialogTitle}>
  <form id={formId} class="form" onsubmit={submit} novalidate aria-busy={loadState === 'loading'}>
    {#if loadState === 'loading'}
      <p class="field-hint" aria-hidden="true">{t('epicLoading')}</p>
    {:else if loadState === 'failed'}
      <div class="callout is-danger" role="alert">
        <Icon name="alert" /><span>{t('epicLoadFailed', { epic: t('epic') })}</span>
      </div>
      <div class="form-actions">
        <button class="btn" type="button" onclick={() => epicId !== null && void load(epicId, generation)}
          >{t('retry')}</button
        >
      </div>
    {:else if loadState === 'ready'}
      <fieldset class="form-fields" disabled={submitting}>
        {#if readOnly}
          <div class="callout is-info">
            <Icon name="shield" /><span>{t('epicReadOnly', { workspace: t('workspace'), epic: t('epic') })}</span>
          </div>
        {/if}

        <div class="field" class:is-invalid={errors.title !== undefined}>
          <label class="field-label" for={fieldIds.title}>{t('fieldTitle')}</label>
          <input
            class="input"
            id={fieldIds.title}
            bind:value={title}
            oninput={() => (errors.title = undefined)}
            placeholder={t('epicTitlePlaceholder')}
            autocomplete="off"
            readonly={readOnly}
            aria-invalid={errors.title !== undefined}
            aria-describedby={errors.title !== undefined ? `${fieldIds.title}-error` : undefined}
          />
          {@render error('title')}
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

        <div class="field">
          {#if readOnly}
            <span class="field-label">{t('category')}</span>
            <span>{categoryName}</span>
          {:else}
            <label class="field-label" for={categoryId}>{t('category')}</label>
            <select
              class="select"
              id={categoryId}
              bind:value={category}
              aria-describedby={categoriesFailed ? `${categoryId}-note` : undefined}
            >
              <option value="">{t('categoryNone', { category: t('category') })}</option>
              {#each categoryOptions as option (option.id)}
                <option value={option.id}>{option.name}</option>
              {/each}
            </select>
          {/if}
          {#if categoriesFailed && !readOnly}
            <span class="field-hint" id="{categoryId}-note"
              >{t('definitionsLoadFailed', { category: t('category') })}</span
            >
          {/if}
        </div>

        <div class="form-row is-start">
          <div class="field" class:is-invalid={errors.due !== undefined}>
            <label class="field-label" for={fieldIds.due}>{t('due')}</label>
            {#if readOnly}
              <input class="input" id={fieldIds.due} type="text" value={dueOn} readonly />
            {:else}
              <input
                class="input"
                id={fieldIds.due}
                type="date"
                bind:this={dueInput}
                bind:value={dueOn}
                oninput={() => (errors.due = undefined)}
                aria-invalid={errors.due !== undefined}
                aria-describedby={errors.due !== undefined ? `${fieldIds.due}-error` : undefined}
              />
            {/if}
            {@render error('due')}
          </div>
          <div class="field" class:is-invalid={errors.link !== undefined}>
            <label class="field-label" for={fieldIds.link}>{t('fieldLink')}</label>
            <div class="input-row">
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
              {#if openHref !== null}
                <a
                  class="btn"
                  href={openHref}
                  target="_blank"
                  rel="external noopener noreferrer"
                  aria-label={t('epicLinkOpenLabel')}>{t('epicLinkOpen')}</a
                >
              {/if}
            </div>
            {@render error('link')}
          </div>
        </div>
      </fieldset>
      {#if editing !== null && !readOnly}
        <div class="form-actions">
          {#if canDelete}
            <button class="btn is-sm is-quiet is-danger" type="button" aria-disabled={submitting} onclick={askDelete}>
              <Icon name="trash" />{t('epicDelete', { epic: t('epic') })}
            </button>
          {:else}
            <span class="field-hint">{t('taskDeleteWho', { leader: t('leader') })}</span>
          {/if}
        </div>
      {/if}
    {/if}

    {#if submitError !== null}
      <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{submitError}</span></div>
    {/if}
  </form>
  <span class="visually-hidden" role="status">{status}</span>
  {#snippet footer(close)}
    {#if readOnly}
      <button class="btn is-primary" type="button" onclick={close}>{t('close')}</button>
    {:else}
      <button class="btn is-quiet" type="button" aria-disabled={submitting} onclick={close}>{t('cancel')}</button>
      <button
        class="btn is-primary"
        type="submit"
        form={formId}
        aria-disabled={submitting || loadState !== 'ready'}
        bind:this={submitButton}
      >
        {submitting ? status : epicId === null ? t('epicCreateSubmit') : t('epicSave')}
      </button>
    {/if}
  {/snippet}
</Dialog>

<TreeDeleteDialog bind:this={deleteDialog} {slug} {workspaceId} onfinish={deleteFinished} />
