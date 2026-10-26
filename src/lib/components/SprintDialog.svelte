<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { isCalendarDate } from '../../shared/due.ts';
  import {
    sprintConflictReasonOf,
    sprintCreate,
    sprintUpdate,
    type SprintSummary,
  } from '../../shared/operations/sprint/index.ts';
  import {
    SPRINT_MAX_LENGTH,
    SPRINT_MIN_LENGTH,
    SPRINT_NAME_MAX_LENGTH,
    normalizeSprintName,
    sprintEndOn,
    sprintNameProblem,
    weekdayOf,
  } from '../../shared/sprint.ts';
  import type { DictionaryKey } from '../../shared/vocabulary.ts';
  import { callOperation } from '../api.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // スプリントの作成と変更のダイアログ（kit.js の DIALOGS.sprintCreate）。欄は開始日、長さ（日）、最終日（開始日と長さから決まる。曜日を添える）、
  // 名前（任意。空なら期間を名前にする）。作るときは、画面が渡す初期値（sprint-list の defaults）で開く。
  // 直すときは、開いたときの値と比べて変えた欄だけを送り、変えた欄が無ければ何も送らずに閉じる。
  // 期間がほかのスプリントと重なったとき（409 の overlap）は、ダイアログの中に理由を出して開いたままにする。
  // 始まっていた（started）、見つからない（404）ときは、トーストで知らせて閉じ、画面が一覧を読み直す（ongone）。
  // 作れたら、保存できたら閉じて、画面が一覧を読み直す（onsaved）
  let {
    slug,
    workspaceId,
    onsaved,
    ongone,
  }: {
    slug: string;
    workspaceId: string;
    onsaved: () => void;
    ongone: () => void;
  } = $props();

  // 曜日の言葉（0 が日曜）
  const WEEKDAY_KEYS = [
    'weekday0',
    'weekday1',
    'weekday2',
    'weekday3',
    'weekday4',
    'weekday5',
    'weekday6',
  ] as const satisfies readonly DictionaryKey[];

  const ids = $props.id();
  const formId = `${ids}-form`;
  const fieldIds = { start: `${ids}-start`, length: `${ids}-length`, name: `${ids}-name` } as const;
  type FieldName = keyof typeof fieldIds;

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let submitButton = $state<HTMLButtonElement>();
  let startInput = $state<HTMLInputElement>();

  // 直す対象。作るときは null
  let editing = $state<SprintSummary | null>(null);
  let startOn = $state('');
  // number の入力は、空や途中の値で null か NaN になる
  let length = $state<number | null>(null);
  let name = $state('');
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

  // 作るときは defaults、直すときは対象の今の値で開く
  export function show(
    trigger: HTMLElement | null,
    target: SprintSummary | null,
    defaults: { start_on: string; length: number },
  ): void {
    generation++;
    reloadOnClose = false;
    editing = target;
    startOn = target?.start_on ?? defaults.start_on;
    length = target?.length ?? defaults.length;
    name = target?.name ?? '';
    errors = {};
    submitError = null;
    submitting = false;
    dialog?.show(trigger);
  }

  const validLength = $derived(
    typeof length === 'number' && Number.isInteger(length) && length >= SPRINT_MIN_LENGTH && length <= SPRINT_MAX_LENGTH
      ? length
      : null,
  );
  const endOn = $derived(validLength !== null && isCalendarDate(startOn) ? sprintEndOn(startOn, validLength) : null);
  const endLabel = $derived(
    endOn === null
      ? '—'
      : t('dateWithWeekday', { date: endOn, weekday: t(WEEKDAY_KEYS[weekdayOf(endOn)] ?? 'weekday0') }),
  );

  // 検査の結果。先頭のエラーの欄へフォーカスを移すため、画面の上から順に並べる
  function validate(): Partial<Record<FieldName, string>> {
    const found: Partial<Record<FieldName, string>> = {};
    if (startInput?.validity.badInput || !isCalendarDate(startOn)) found.start = t('sprintStartRequired');
    if (validLength === null) {
      found.length = t('sprintLengthInvalid', { min: SPRINT_MIN_LENGTH, max: SPRINT_MAX_LENGTH });
    } else if (found.start === undefined && endOn === null) {
      found.length = t('sprintEndOutOfRange');
    }
    const problem = sprintNameProblem(normalizeSprintName(name));
    if (problem === 'too_long') found.name = t('sprintNameTooLong', { max: SPRINT_NAME_MAX_LENGTH });
    if (problem === 'invalid_character') found.name = t('sprintNameInvalidCharacter');
    return found;
  }

  // 開いたときの値と比べて、変えた欄だけ
  function changedFields(nextLength: number) {
    const next = { start_on: startOn, length: nextLength, name: normalizeSprintName(name) };
    const original = editing;
    if (original === null) return next;
    const changed: Partial<typeof next> = {};
    if (next.start_on !== original.start_on) changed.start_on = next.start_on;
    if (next.length !== original.length) changed.length = next.length;
    if (next.name !== original.name) changed.name = next.name;
    return changed;
  }

  function gone(key: DictionaryKey): void {
    open = false;
    showToast(t(key, { sprint: t('sprint') }), 'alert');
    ongone();
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    errors = validate();
    const firstInvalid = (Object.keys(fieldIds) as FieldName[]).find((field) => errors[field] !== undefined);
    if (firstInvalid !== undefined || validLength === null) {
      if (firstInvalid !== undefined) document.getElementById(fieldIds[firstInvalid])?.focus();
      return;
    }
    const fields = changedFields(validLength);
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
              sprintCreate,
              { workspace_id: workspaceId, ...(fields as Required<typeof fields>) },
              { slug },
            )
          : await callOperation(
              sprintUpdate,
              { workspace_id: workspaceId, sprint_id: editing.id, ...fields },
              { slug },
            );
      if (mine !== generation) return;
      if (!result.ok) {
        if (result.status === 401) {
          await invalidateAll();
          return;
        }
        const reason = result.error?.code === 'conflict' ? sprintConflictReasonOf(result.error.details) : undefined;
        if (reason === 'overlap') {
          submitError = t('sprintOverlap', { sprint: t('sprint') });
        } else if (reason === 'started') {
          gone('sprintStarted');
        } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
          submitError = t('workspaceClosedReadOnly', { workspace: t('workspace') });
          reloadOnClose = true;
        } else if (result.status === 404 && editing !== null) {
          gone('sprintGone');
        } else if (result.status === 403) {
          submitError = t('sprintForbidden', { sprint: t('sprint'), leader: t('leader') });
          reloadOnClose = true;
        } else if (result.status === 400) {
          submitError = t('sprintBadRequest');
        } else {
          submitError = editing === null ? t('sprintCreateFailed') : t('sprintSaveFailed');
        }
        return;
      }
      const created = editing === null;
      open = false;
      showToast(t(created ? 'sprintCreated' : 'sprintSaved', { sprint: t('sprint') }), 'check');
      onsaved();
    } finally {
      if (mine === generation) submitting = false;
    }
  }

  const status = $derived(submitting ? (editing === null ? t('sprintCreating') : t('sprintSaving')) : '');
  const dialogTitle = $derived(
    editing === null ? t('sprintCreate', { sprint: t('sprint') }) : t('sprintEdit', { sprint: t('sprint') }),
  );
</script>

{#snippet error(field: FieldName)}
  {#if errors[field] !== undefined}
    <span class="field-error" id="{fieldIds[field]}-error" role="alert"><Icon name="alert" />{errors[field]}</span>
  {/if}
{/snippet}

<Dialog bind:this={dialog} bind:open dismissible={!submitting} title={dialogTitle}>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    <fieldset class="form-fields" disabled={submitting}>
      <div class="form-row is-start">
        <div class="field" class:is-invalid={errors.start !== undefined}>
          <label class="field-label" for={fieldIds.start}>{t('sprintFieldStart')}</label>
          <input
            class="input"
            id={fieldIds.start}
            type="date"
            bind:this={startInput}
            bind:value={startOn}
            oninput={() => (errors.start = undefined)}
            aria-invalid={errors.start !== undefined}
            aria-describedby={errors.start !== undefined ? `${fieldIds.start}-error` : undefined}
          />
          {@render error('start')}
        </div>
        <div class="field" class:is-invalid={errors.length !== undefined}>
          <label class="field-label" for={fieldIds.length}>{t('sprintFieldLength')}</label>
          <input
            class="input"
            id={fieldIds.length}
            type="number"
            inputmode="numeric"
            min={SPRINT_MIN_LENGTH}
            max={SPRINT_MAX_LENGTH}
            step="1"
            bind:value={length}
            oninput={() => (errors.length = undefined)}
            aria-invalid={errors.length !== undefined}
            aria-describedby={errors.length !== undefined ? `${fieldIds.length}-error` : undefined}
          />
          {@render error('length')}
        </div>
        <div class="field">
          <span class="field-label">{t('sprintFieldEnd')}</span>
          <span class="mono" data-sprint-end>{endLabel}</span>
        </div>
      </div>

      <div class="field" class:is-invalid={errors.name !== undefined}>
        <label class="field-label" for={fieldIds.name}>{t('sprintFieldName')}</label>
        <input
          class="input"
          id={fieldIds.name}
          bind:value={name}
          oninput={() => (errors.name = undefined)}
          placeholder={t('sprintNamePlaceholder')}
          autocomplete="off"
          aria-invalid={errors.name !== undefined}
          aria-describedby={errors.name !== undefined ? `${fieldIds.name}-error` : undefined}
        />
        {@render error('name')}
      </div>
      <p class="field-hint">
        {t('sprintFormHint', {
          min: SPRINT_MIN_LENGTH,
          max: SPRINT_MAX_LENGTH,
          backlog: t('backlog'),
          task: t('task'),
        })}
      </p>
    </fieldset>

    {#if submitError !== null}
      <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{submitError}</span></div>
    {/if}
  </form>
  <span class="visually-hidden" role="status">{status}</span>
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" aria-disabled={submitting} onclick={close}>{t('cancel')}</button>
    <button class="btn is-primary" type="submit" form={formId} aria-disabled={submitting} bind:this={submitButton}>
      {submitting ? status : editing === null ? t('sprintCreateSubmit') : t('sprintSave')}
    </button>
  {/snippet}
</Dialog>
