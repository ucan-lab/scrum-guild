<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { sprintConflictReasonOf, sprintStart, type SprintPlan } from '../../shared/operations/sprint/index.ts';
  import { SPRINT_GOAL_MAX_LENGTH, normalizeSprintGoal, sprintGoalProblem } from '../../shared/sprint.ts';
  import { callOperation } from '../api.ts';
  import { sprintLabel, sprintPeriod } from '../sprint-label.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // スプリントを始めるダイアログ（kit.js の DIALOGS.sprintStart）。始める先のスプリントの名前と期間、入っているタスクの件数とポイント、
  // 未見積もりの件数（あれば。始めることはできる）、ゴールの欄（任意。空でも始められる）。
  // 進行中のスプリントが既にあるときは、押す前から理由を出して「始める」を押せなくする（aria-disabled）。
  // 同時に別の画面で始められて断られたとき（409 の active_exists）も、同じ理由をダイアログの中に出して開いたままにし、
  // 閉じたら一覧を読み直す。最終日がワークスペースの今日より前（409 の ended）のときも、理由をダイアログの中に出して開いたままにする。もう始まっている（started）、見つからない（404）ときは、トーストで知らせて閉じ、一覧を読み直す（ongone）。
  // 始められたら閉じて、画面が一覧を読み直す（onstarted）
  let {
    slug,
    workspaceId,
    onstarted,
    ongone,
  }: {
    slug: string;
    workspaceId: string;
    // 始めたスプリントの ID を渡す（押した「始める」は一覧から消えるので、画面がフォーカスの行き先を決める）
    onstarted: (sprintId: string) => void;
    ongone: () => void;
  } = $props();

  const ids = $props.id();
  const formId = `${ids}-form`;
  const goalId = `${ids}-goal`;

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let submitButton = $state<HTMLButtonElement>();

  let target = $state<SprintPlan | null>(null);
  let activeExists = $state(false);
  let goal = $state('');
  let goalError = $state<string | null>(null);
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

  // activeAlready は、開いた時点で進行中のスプリントが別にあるか
  export function show(trigger: HTMLElement | null, sprint: SprintPlan, activeAlready: boolean): void {
    generation++;
    reloadOnClose = false;
    target = sprint;
    activeExists = activeAlready;
    goal = '';
    goalError = null;
    submitError = null;
    submitting = false;
    dialog?.show(trigger);
  }

  const points = $derived((target?.tasks ?? []).reduce((total, task) => total + (task.points ?? 0), 0));
  const unestimated = $derived((target?.tasks ?? []).filter((task) => task.points === null).length);
  const blocked = $derived(activeExists);

  function goalProblemText(value: string | null): string | null {
    const problem = sprintGoalProblem(value);
    if (problem === 'too_long') {
      return t('sprintStartGoalTooLong', { sprintGoal: t('sprintGoal'), max: SPRINT_GOAL_MAX_LENGTH });
    }
    if (problem === 'invalid_character') return t('sprintStartGoalInvalidCharacter', { sprintGoal: t('sprintGoal') });
    return null;
  }

  function gone(message: string): void {
    open = false;
    showToast(message, 'alert');
    ongone();
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting || target === null || blocked) return;
    const value = normalizeSprintGoal(goal);
    goalError = goalProblemText(value);
    if (goalError !== null) {
      document.getElementById(goalId)?.focus();
      return;
    }

    const mine = generation;
    submitting = true;
    submitError = null;
    submitButton?.focus();
    try {
      const result = await callOperation(
        sprintStart,
        { workspace_id: workspaceId, sprint_id: target.id, goal: value },
        { slug },
      );
      if (mine !== generation) return;
      if (!result.ok) {
        if (result.status === 401) {
          await invalidateAll();
          return;
        }
        const reason = result.error?.code === 'conflict' ? sprintConflictReasonOf(result.error.details) : undefined;
        if (reason === 'active_exists') {
          activeExists = true;
          submitError = t('sprintStartActiveExists', { sprint: t('sprint') });
          reloadOnClose = true;
        } else if (reason === 'ended') {
          submitError = t('sprintStartEnded', { sprint: t('sprint') });
        } else if (reason === 'started') {
          gone(t('sprintStartAlreadyStarted', { sprint: t('sprint') }));
        } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
          submitError = t('workspaceClosedReadOnly', { workspace: t('workspace') });
          reloadOnClose = true;
        } else if (result.status === 404) {
          gone(t('sprintGone', { sprint: t('sprint') }));
        } else if (result.status === 403) {
          submitError = t('sprintStartForbidden', { sprint: t('sprint'), leader: t('leader') });
          reloadOnClose = true;
        } else if (result.status === 400) {
          submitError = t('sprintBadRequest');
        } else {
          submitError = t('sprintStartFailed');
        }
        return;
      }
      open = false;
      showToast(t('sprintStartDone', { sprint: t('sprint') }), 'check');
      onstarted(target.id);
    } finally {
      if (mine === generation) submitting = false;
    }
  }

  const status = $derived(submitting ? t('sprintStarting') : '');
</script>

<Dialog bind:this={dialog} bind:open dismissible={!submitting} title={t('sprintStartTitle', { sprint: t('sprint') })}>
  {#if target !== null}
    <form id={formId} class="form" onsubmit={submit} novalidate>
      <p>
        {t('sprintStartText', {
          label: sprintLabel(target, t),
          period: sprintPeriod(target, t),
          task: t('task'),
          count: target.tasks.length,
          points,
        })}
      </p>
      {#if blocked}
        <div class="callout is-danger" role="alert">
          <Icon name="alert" /><span>{t('sprintStartActiveExists', { sprint: t('sprint') })}</span>
        </div>
      {:else if unestimated > 0}
        <div class="callout is-warn">
          <Icon name="alert" /><span>{t('sprintStartUnestimated', { count: unestimated })}</span>
        </div>
      {/if}
      <fieldset class="form-fields" disabled={submitting}>
        <div class="field" class:is-invalid={goalError !== null}>
          <label class="field-label" for={goalId}>{t('sprintGoal')}</label>
          <textarea
            class="textarea"
            id={goalId}
            bind:value={goal}
            oninput={() => (goalError = null)}
            placeholder={t('sprintStartGoalPlaceholder', { sprint: t('sprint') })}
            aria-invalid={goalError !== null}
            aria-describedby="{goalId}-hint{goalError !== null ? ` ${goalId}-error` : ''}"></textarea>
          {#if goalError !== null}
            <span class="field-error" id="{goalId}-error" role="alert"><Icon name="alert" />{goalError}</span>
          {/if}
          <span class="field-hint" id="{goalId}-hint">
            {t('sprintStartGoalHint', { plan: t('plan'), sprint: t('sprint'), max: SPRINT_GOAL_MAX_LENGTH })}
          </span>
        </div>
      </fieldset>
      {#if submitError !== null && !blocked}
        <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{submitError}</span></div>
      {/if}
    </form>
  {/if}
  <span class="visually-hidden" role="status">{status}</span>
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" aria-disabled={submitting} onclick={close}>{t('cancel')}</button>
    <button
      class="btn is-primary"
      type="submit"
      form={formId}
      aria-disabled={submitting || blocked}
      bind:this={submitButton}
    >
      {submitting ? status : t('sprintStartSubmit')}
    </button>
  {/snippet}
</Dialog>
