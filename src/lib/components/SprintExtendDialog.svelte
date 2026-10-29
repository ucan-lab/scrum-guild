<script lang="ts">
  import { tick } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import {
    sprintExtend,
    sprintList,
    sprintConflictReasonOf,
    type SprintSummary,
  } from '../../shared/operations/sprint/index.ts';
  import { SPRINT_MAX_LENGTH, sprintExtension } from '../../shared/sprint.ts';
  import { callOperation } from '../api.ts';
  import { sprintLabel, sprintPeriod } from '../sprint-label.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  let {
    slug,
    workspaceId,
    onextended,
    ongone,
  }: {
    slug: string;
    workspaceId: string;
    onextended: () => void;
    ongone: () => void;
  } = $props();
  const ids = $props.id();
  const formId = `${ids}-form`;
  const daysId = `${ids}-days`;
  let dialog = $state<ReturnType<typeof Dialog>>();
  let submitButton = $state<HTMLButtonElement>();
  let open = $state(false);
  let target = $state<SprintSummary | null>(null);
  let current = $state<SprintSummary | null>(null);
  let sprints = $state<SprintSummary[]>([]);
  let days = $state<number | null>(1);
  let loading = $state(false);
  let loadFailed = $state(false);
  let submitting = $state(false);
  let fieldError = $state<string | null>(null);
  let submitError = $state<string | null>(null);
  let generation = 0;
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
      open = false;
      submitting = false;
    };
  });

  export function show(trigger: HTMLElement | null, sprint: SprintSummary): void {
    generation++;
    target = sprint;
    current = null;
    sprints = [];
    days = 1;
    fieldError = null;
    submitError = null;
    submitting = false;
    loading = false;
    loadFailed = false;
    reloadOnClose = false;
    dialog?.show(trigger);
    void load();
  }

  function gone(): void {
    open = false;
    showToast(t('sprintExtendNotActive', { sprint: t('sprint') }), 'alert');
    ongone();
  }

  async function load(): Promise<void> {
    if (target === null || loading) return;
    const mine = generation;
    const id = target.id;
    loading = true;
    const result = await callOperation(sprintList, { workspace_id: workspaceId }, { slug });
    if (mine !== generation) return;
    loading = false;
    if (!result.ok) {
      if (result.status === 401) {
        await invalidateAll();
        return;
      }
      loadFailed = true;
      return;
    }
    loadFailed = false;
    const found = result.data.sprints.find((sprint) => sprint.id === id);
    if (found === undefined || found.status !== 'active') {
      gone();
      return;
    }
    current = found;
    sprints = result.data.sprints;
    await tick();
    if (mine === generation && open) document.getElementById(daysId)?.focus();
  }

  const maxDays = $derived(current === null ? 0 : SPRINT_MAX_LENGTH - current.length);
  const validDays = $derived(
    typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= maxDays ? days : null,
  );
  const preview = $derived(
    current !== null && validDays !== null ? sprintExtension(current, validDays, sprints) : null,
  );
  const status = $derived(submitting ? t('sprintExtending') : '');

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting || loading || loadFailed || current === null || maxDays < 1) return;
    if (validDays === null || preview === null) {
      fieldError = t('sprintExtendInvalid', { max: maxDays });
      document.getElementById(daysId)?.focus();
      return;
    }
    const mine = generation;
    const requestedDays = validDays;
    submitting = true;
    submitError = null;
    fieldError = null;
    submitButton?.focus();
    try {
      const result = await callOperation(
        sprintExtend,
        { workspace_id: workspaceId, sprint_id: current.id, days: requestedDays },
        { slug },
      );
      if (mine !== generation) return;
      if (result.ok) {
        open = false;
        showToast(t('sprintExtendDone', { sprint: t('sprint'), days: requestedDays }), 'check');
        onextended();
        return;
      }
      if (result.status === 401) {
        await invalidateAll();
        return;
      }
      const reason = result.error?.code === 'conflict' ? sprintConflictReasonOf(result.error.details) : undefined;
      if (reason === 'not_active' || result.status === 404) {
        gone();
        return;
      }
      if (result.error?.code === 'workspace_closed') {
        submitError = t('workspaceClosedReadOnly', { workspace: t('workspace') });
        reloadOnClose = true;
      } else if (result.status === 403) {
        submitError = t('sprintForbidden', { sprint: t('sprint'), leader: t('leader') });
        reloadOnClose = true;
      } else if (reason === 'overlap' || reason === 'changed' || result.status === 400) {
        submitError = reason === 'overlap' ? t('sprintOverlap', { sprint: t('sprint') }) : t('sprintExtendChanged');
        await load();
      } else submitError = t('sprintExtendFailed');
    } finally {
      if (mine === generation) submitting = false;
    }
  }
</script>

<Dialog bind:this={dialog} bind:open dismissible={!submitting} title={t('sprintExtendTitle', { sprint: t('sprint') })}>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    {#if loadFailed}
      <div class="callout is-danger" role="alert">
        <Icon name="alert" /><span>{t('sprintExtendLoadFailed')}</span>
        <div class="callout-actions">
          <button class="btn is-sm" type="button" aria-disabled={loading} onclick={() => !loading && void load()}
            >{loading ? t('retrying') : t('retry')}</button
          >
        </div>
      </div>
    {:else if current === null}
      <p class="props-note" role="status">{t('loading')}</p>
    {:else}
      <p>{sprintLabel(current, t)}（{sprintPeriod(current, t)}）</p>
      {#if maxDays < 1}
        <p class="callout" role="status">{t('sprintExtendLimit')}</p>
      {:else}
        <fieldset class="form-fields" disabled={submitting || loading}>
          <div class="field" class:is-invalid={fieldError !== null}>
            <label class="field-label" for={daysId}>{t('sprintExtendDays')}</label>
            <input
              class="input"
              id={daysId}
              type="number"
              min="1"
              max={maxDays}
              step="1"
              inputmode="numeric"
              bind:value={days}
              oninput={() => (fieldError = null)}
              aria-invalid={fieldError !== null}
              aria-describedby={fieldError !== null ? `${daysId}-error` : undefined}
            />
            {#if fieldError !== null}<span class="field-error" id="{daysId}-error" role="alert"
                ><Icon name="alert" />{fieldError}</span
              >{/if}
          </div>
          {#if preview !== null}
            <div class="field">
              <span class="field-label">{t('sprintExtendEnd')}</span><span class="mono" data-sprint-extend-end
                >{preview.end_on}</span
              >
            </div>
            <div class="form-fields" aria-live="polite">
              {#each preview.shifted as shifted (shifted.id)}
                {@const original = sprints.find((sprint) => sprint.id === shifted.id)!}
                <div class="field">
                  <span class="field-label">{sprintLabel(original, t)}</span><span data-sprint-shift
                    >{t('sprintExtendShift', {
                      before: sprintPeriod(original, t),
                      after: sprintPeriod(shifted, t),
                      days: shifted.days,
                    })}</span
                  >
                </div>
              {:else}<p class="props-note">{t('sprintExtendNoShift', { sprint: t('sprint') })}</p>{/each}
            </div>
          {/if}
        </fieldset>
      {/if}
      <p class="field-hint">{t('sprintExtendVelocity', { sprint: t('sprint') })}</p>
    {/if}
    {#if submitError !== null}<div class="callout is-danger" role="alert">
        <Icon name="alert" /><span>{submitError}</span>
      </div>{/if}
  </form>
  <span class="visually-hidden" role="status">{status}</span>
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" aria-disabled={submitting} onclick={close}>{t('cancel')}</button>
    <button
      class="btn is-primary"
      type="submit"
      form={formId}
      aria-disabled={submitting || loading || loadFailed || current === null || maxDays < 1}
      bind:this={submitButton}>{submitting ? status : t('sprintExtendAction')}</button
    >
  {/snippet}
</Dialog>
