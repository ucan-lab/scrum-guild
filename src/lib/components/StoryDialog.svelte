<script lang="ts">
  import { tick } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { storyCreate, storyGet, storyUpdate, type StoryDetail } from '../../shared/operations/story/index.ts';
  import {
    LINK_URL_MAX_LENGTH,
    STORY_TEXT_MAX_LENGTH,
    STORY_TITLE_MAX_LENGTH,
    canonicalLinkUrl,
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
  // 直すときは、開いたら story-get で1件を読む（受け入れ基準と本文は長いので、木には載せない）。読んでいる間は読み込み中を出し、
  // 読めなければ（404 以外）もう一度試すを出す。404 は、トーストで知らせて閉じ、画面が木を読み直す（ongone）。
  // 開いたときの値と比べて、変えた欄だけを送る（別の人が別の欄を直していれば両方が残り、同じ欄は後の保存が勝つ）。
  // 変えた欄が無ければ、何も送らずに閉じる。閉じたワークスペース（canWrite が偽）では読み取り専用で開き、保存のボタンを出さない
  // （欄は readonly。日付の入力は readonly を受けないので、読み取り専用の text に日付を出す）。
  // 送っている間の扱いと、古い応答を捨てる generation は TaskCreateDialog と同じ。
  // 作れたら、保存できたら閉じて、画面が木を読み直す（onsaved）。本文と受け入れ基準は、この版では文字のまま持つ
  let {
    slug,
    workspaceId,
    canWrite,
    onsaved,
    ongone,
  }: {
    slug: string;
    workspaceId: string;
    canWrite: boolean;
    onsaved: () => void;
    // 直す対象が消えていた（404）。画面が木を読み直し、見出しへフォーカスを移す
    ongone: () => void;
  } = $props();

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
  let dueInput = $state<HTMLInputElement>();

  // 直すときの対象の ID。作るときは null
  let storyId = $state<string | null>(null);
  // 直すときは、読み込み中、読めた、読めなかった。作るときは読めた扱い
  let loadState = $state<'loading' | 'ready' | 'failed'>('ready');
  // 開いたときに読んだ値（直すときだけ）
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

  function fill(story: StoryDetail | null): void {
    editing = story;
    title = story?.title ?? '';
    acceptance = story?.acceptance_criteria_md ?? '';
    body = story?.body_md ?? '';
    dueOn = story?.due_on ?? '';
    link = story?.link_url ?? '';
  }

  // 直すときの1件を読む。応答が来た時点で開き直されていたら（generation が進んでいたら）捨てる
  async function load(id: string, mine: number): Promise<void> {
    loadState = 'loading';
    submitError = null;
    const result = await callOperation(storyGet, { workspace_id: workspaceId, story_id: id }, { slug });
    if (mine !== generation) return;
    if (result.ok) {
      fill(result.data.story);
      loadState = 'ready';
      // 欄は読めてから出るので、開いたときのフォーカス（閉じるボタン）から、タイトルへ移す
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
      showToast(t('storyGone', { story: t('story') }), 'alert');
      ongone();
      return;
    }
    loadState = 'failed';
  }

  export function show(trigger?: HTMLElement | null, targetId: string | null = null): void {
    generation++;
    reloadOnClose = false;
    storyId = targetId;
    fill(null);
    errors = {};
    submitError = null;
    submitting = false;
    loadState = targetId === null ? 'ready' : 'loading';
    dialog?.show(trigger);
    if (targetId !== null) void load(targetId, generation);
  }

  const readOnly = $derived(!canWrite);

  const titleMessages = $derived<Record<StoryTitleProblem, string>>({
    required: t('storyTitleRequired'),
    too_long: t('storyTitleTooLong', { max: STORY_TITLE_MAX_LENGTH }),
    invalid_character: t('storyTitleInvalidCharacter'),
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
    // 日付の入力は、途中までしか打たれていない値や存在しない日付だと、value が空になり、validity.badInput が立つ
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
    // 欄が disabled になるので、Enter で送ったときもフォーカスを失わないよう、送るボタンへ移す
    submitButton?.focus();
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
          ongone();
        } else if (result.status === 400) {
          // 画面の検査を通った後に断られた。どの欄かは分からないので、タイトルを責めずに全体の文で知らせる
          submitError = t('storyBadRequest');
        } else {
          submitError = editing === null ? t('storyCreateFailed') : t('storySaveFailed');
        }
        return;
      }
      const created = editing === null;
      open = false;
      showToast(t(created ? 'storyCreated' : 'storySaved', { story: t('story') }), 'check');
      onsaved();
    } finally {
      if (mine === generation) submitting = false;
    }
  }

  const status = $derived(
    loadState === 'loading'
      ? t('storyLoading')
      : submitting
        ? storyId === null
          ? t('storyCreating')
          : t('storySaving')
        : '',
  );
  const dialogTitle = $derived(storyId === null ? t('storyCreate', { story: t('story') }) : t('story'));
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
    {#if loadState === 'failed'}
      <div class="callout is-danger" role="alert">
        <Icon name="alert" /><span>{t('storyLoadFailed', { story: t('story') })}</span>
      </div>
      <div class="form-actions">
        <button class="btn" type="button" onclick={() => storyId !== null && void load(storyId, generation)}
          >{t('retry')}</button
        >
      </div>
    {:else if loadState === 'ready'}
      <!-- 送っている間は、欄も変えられない。送るボタンはフォーカスを残すため、欄のまとまりの外で aria-disabled にしている -->
      <fieldset class="form-fields" disabled={submitting}>
        {#if readOnly}
          <div class="callout is-info">
            <Icon name="shield" /><span>{t('storyReadOnly', { workspace: t('workspace'), story: t('story') })}</span>
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
                <!-- 外のサイトは新しいタブで開く。読み上げにも、新しいタブで開くことを含める -->
                <a
                  class="btn"
                  href={openHref}
                  target="_blank"
                  rel="external noopener noreferrer"
                  aria-label={t('storyLinkOpenLabel')}>{t('storyLinkOpen')}</a
                >
              {/if}
            </div>
            {@render error('link')}
          </div>
        </div>
      </fieldset>
    {/if}

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
      <button
        class="btn is-primary"
        type="submit"
        form={formId}
        aria-disabled={submitting || loadState !== 'ready'}
        bind:this={submitButton}
      >
        {submitting ? status : storyId === null ? t('storyCreateSubmit') : t('storySave')}
      </button>
    {/if}
  {/snippet}
</Dialog>
