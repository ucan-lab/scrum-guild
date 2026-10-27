<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import {
    SPRINT_TASK_ADD_MAX,
    sprintTaskAdd,
    sprintTaskConflictReasonOf,
    type SprintSummary,
  } from '../../shared/operations/sprint/index.ts';
  import { backlogTree } from '../../shared/operations/task/index.ts';
  import type { BacklogTask } from '../../shared/operations/task/backlog-tree.ts';
  import { callOperation } from '../api.ts';
  import { sprintLabel } from '../sprint-label.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // 計画の画面の「<バックログ>から入れる」のダイアログ（design/plan.html）。開くたびにバックログの木（backlog-tree）を読み、
  // 「<ストーリー>ごと入れる」（配下の未完了のタスクのうち、このスプリントに入っていないものがあるストーリー）と、
  // 「<タスク>を1件ずつ入れる」（このスプリントに入っていない未完了のタスク。親のストーリーの下に、親のないタスクは最後にまとめる）を
  // チェックボックスの .choice で並べる。ほかのスプリントに入っているタスクには「<スプリント> から移します」を添える。
  // 選んだストーリーの配下と選んだタスクを、木の順で1回の sprint-task-add に送る（入れる単位はタスク）。
  // 入れられたら閉じて、入れた件数と、飛ばした件数を理由ごとにトーストで知らせ、画面が一覧を読み直す（onadded）。
  // 1件も入らなかったとき（終了した、完了した、見つからない）は、理由をトーストで知らせて閉じ、読み直す
  let {
    slug,
    workspaceId,
    onadded,
  }: {
    slug: string;
    workspaceId: string;
    onadded: () => void;
  } = $props();

  type Group = { id: string | null; title: string; tasks: BacklogTask[] };

  const ids = $props.id();
  const formId = `${ids}-form`;
  const storiesLabelId = `${ids}-stories`;
  const tasksLabelId = `${ids}-tasks`;
  const hintId = `${ids}-hint`;

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let sprint = $state<SprintSummary | null>(null);
  let groups = $state<Group[]>([]);
  let loading = $state(false);
  let loadFailed = $state(false);
  let submitting = $state(false);
  let submitError = $state<string | null>(null);
  let pickedStories = $state<string[]>([]);
  let pickedTasks = $state<string[]>([]);
  // 開き直しで進める。古い応答が、今の状態を上書きしない
  let generation = 0;

  export function show(trigger: HTMLElement | null, target: SprintSummary): void {
    generation++;
    sprint = target;
    groups = [];
    pickedStories = [];
    pickedTasks = [];
    submitError = null;
    submitting = false;
    dialog?.show(trigger);
    void load();
  }

  async function load(): Promise<void> {
    const mine = generation;
    const target = sprint;
    if (target === null) return;
    loading = true;
    loadFailed = false;
    const result = await callOperation(backlogTree, { workspace_id: workspaceId }, { slug });
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
    // このスプリントに入っていない未完了のタスクだけ。木の順（エピックの下のストーリー、親のないストーリー、親のないタスク）
    const outside = (tasks: readonly BacklogTask[]) => tasks.filter((task) => task.sprint?.id !== target.id);
    const stories = [...result.data.epics.flatMap((epic) => epic.stories), ...result.data.stories].filter(
      (story) => story.completed_at === null,
    );
    groups = [
      ...stories.map((story) => ({ id: story.id, title: story.title, tasks: outside(story.tasks) })),
      { id: null, title: t('sprintTaskAddRootTasks', { task: t('task') }), tasks: outside(result.data.tasks) },
    ].filter((group) => group.tasks.length > 0);
  }

  // 送るタスクの ID。選んだストーリーの配下と、選んだタスクを、木の順に重ねずに並べる
  const chosen = $derived(
    groups.flatMap((group) =>
      group.tasks
        .filter((task) => (group.id !== null && pickedStories.includes(group.id)) || pickedTasks.includes(task.id))
        .map((task) => task.id),
    ),
  );
  const storyGroups = $derived(groups.filter((group) => group.id !== null));
  const tooMany = $derived(chosen.length > SPRINT_TASK_ADD_MAX);

  function inSprintNote(task: BacklogTask): string | null {
    return task.sprint === null ? null : t('sprintTaskAddInSprint', { label: sprintLabel(task.sprint, t) });
  }

  function skippedText(skipped: { completed: number; unavailable: number; already: number }): string[] {
    const parts: string[] = [];
    if (skipped.completed > 0)
      parts.push(t('sprintTaskSkippedCompleted', { count: skipped.completed, done: t('done') }));
    if (skipped.unavailable > 0) parts.push(t('sprintTaskSkippedUnavailable', { count: skipped.unavailable }));
    if (skipped.already > 0) parts.push(t('sprintTaskSkippedAlready', { count: skipped.already }));
    return parts;
  }

  // 1件も入らなかった。どれも読み直さないと直らないので、トーストで知らせて閉じ、画面が読み直す
  function failed(message: string): void {
    open = false;
    showToast(message, 'alert');
    onadded();
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting || sprint === null) return;
    if (chosen.length === 0) {
      submitError = t('sprintTaskAddNoneSelected', { task: t('task'), story: t('story') });
      return;
    }
    if (tooMany) return;
    const mine = generation;
    submitting = true;
    submitError = null;
    try {
      const result = await callOperation(
        sprintTaskAdd,
        { workspace_id: workspaceId, sprint_id: sprint.id, task_ids: chosen },
        { slug },
      );
      if (mine !== generation) return;
      if (result.ok) {
        open = false;
        const message = [t('sprintTaskAdded', { count: result.data.added }), ...skippedText(result.data.skipped)].join(
          '。',
        );
        showToast(message, 'check');
        onadded();
        return;
      }
      if (result.status === 401) {
        await invalidateAll();
        return;
      }
      const words = { sprint: t('sprint'), task: t('task'), done: t('done'), workspace: t('workspace') };
      const reason = result.error?.code === 'conflict' ? sprintTaskConflictReasonOf(result.error.details) : undefined;
      if (reason === 'closed') failed(t('sprintTaskClosed', words));
      else if (reason === 'completed') failed(t('sprintTaskAddCompleted', words));
      else if (result.status === 409 && result.error?.code === 'workspace_closed') {
        failed(t('workspaceClosedReadOnly', words));
        await invalidateAll();
      } else if (result.status === 404) failed(t('sprintTaskAddGone', words));
      else if (result.status === 403) {
        failed(t('sprintTaskAddFailed'));
        await invalidateAll();
      } else submitError = t('sprintTaskAddFailed');
    } finally {
      if (mine === generation) submitting = false;
    }
  }

  const status = $derived(submitting ? t('sprintTaskAdding') : loading ? t('loading') : '');
  const title = $derived(sprint === null ? '' : t('sprintTaskAddTitle', { label: sprintLabel(sprint, t) }));
</script>

<Dialog bind:this={dialog} bind:open dismissible={!submitting} {title}>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    <p class="field-hint" id={hintId}>
      {t('sprintTaskAddHint', { story: t('story'), task: t('task'), sprint: t('sprint') })}
    </p>
    {#if loading}
      <p class="action-note">{t('loading')}</p>
    {:else if loadFailed}
      <div class="callout is-warn">
        <Icon name="alert" /><span>{t('sprintTaskTreeFailed', { backlog: t('backlog') })}</span>
        <button class="btn is-sm" type="button" onclick={() => void load()}>{t('retry')}</button>
      </div>
    {:else if groups.length === 0}
      <p class="action-note">{t('sprintTaskAddNothing', { task: t('task'), backlog: t('backlog') })}</p>
    {:else}
      <fieldset class="form-fields" disabled={submitting}>
        {#if storyGroups.length > 0}
          <div class="field">
            <span class="field-label" id={storiesLabelId}>{t('sprintTaskAddStories', { story: t('story') })}</span>
            <div class="choice-list" role="group" aria-labelledby={storiesLabelId}>
              {#each storyGroups as group (group.id)}
                <label class="choice">
                  <input
                    type="checkbox"
                    value={group.id}
                    bind:group={pickedStories}
                    onchange={() => (submitError = null)}
                  />
                  <div>
                    <b>{group.title}</b><span
                      >{t('sprintTaskAddStoryMeta', { task: t('task'), count: group.tasks.length })}</span
                    >
                  </div>
                </label>
              {/each}
            </div>
          </div>
        {/if}
        <div class="field">
          <span class="field-label" id={tasksLabelId}>{t('sprintTaskAddTasks', { task: t('task') })}</span>
          <div class="choice-list" role="group" aria-labelledby={tasksLabelId}>
            {#each groups as group (group.id ?? '')}
              {#each group.tasks as task (task.id)}
                {@const note = inSprintNote(task)}
                <label class="choice">
                  <input
                    type="checkbox"
                    value={task.id}
                    bind:group={pickedTasks}
                    onchange={() => (submitError = null)}
                  />
                  <div>
                    <b>{task.title}</b><span
                      >{group.title}{task.points === null
                        ? ''
                        : `・${t('pointsLabel', { points: t('points'), value: task.points })}`}{note === null
                        ? ''
                        : `・${note}`}</span
                    >
                  </div>
                </label>
              {/each}
            {/each}
          </div>
        </div>
      </fieldset>
    {/if}
    {#if tooMany}
      <div class="callout is-warn" role="alert">
        <Icon name="alert" /><span>{t('sprintTaskAddTooMany', { max: SPRINT_TASK_ADD_MAX, task: t('task') })}</span>
      </div>
    {/if}
    {#if submitError !== null}
      <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{submitError}</span></div>
    {/if}
  </form>
  <span class="visually-hidden" role="status">{status}</span>
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" aria-disabled={submitting} onclick={close}>{t('cancel')}</button>
    <button
      class="btn is-primary"
      type="submit"
      form={formId}
      aria-disabled={submitting || loading || chosen.length === 0 || tooMany}
    >
      {submitting ? t('sprintTaskAdding') : t('sprintTaskAddSubmit', { count: chosen.length })}
    </button>
  {/snippet}
</Dialog>
