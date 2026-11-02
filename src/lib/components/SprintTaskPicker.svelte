<script lang="ts">
  import { tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
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

  // 計画の画面の「<バックログ>から入れる」のダイアログ（design/plan.html、kit.js の DIALOGS.sprintTaskAdd）。開くたびにバックログの木
  // （backlog-tree）を読み、このスプリントに入っていない未完了のタスクを、ストーリーを見出し（.pick-row.is-head）にして配下を字下げした行
  // （.pick-row.is-child）で並べる。親のないタスクは別の見出しの下。同じタスクを二度描かない。
  // 見出しのチェックで配下をまとめて選び、1件ずつ外せる（一部だけ選んでいれば indeterminate）。タイトルで絞る検索欄を持ち、一覧（.pick-list）は
  // 高さに上限を付けて中でスクロールし、足元に選んだ件数（.pick-count）と主ボタンを保つ。ほかのスプリントに入っているタスクには
  // 「<スプリント> から移します」を添える。選んだタスクを木の順で1回の sprint-task-add に送る（入れる単位はタスク）。
  // 全部入ったら閉じてトーストで知らせ、画面が一覧を読み直す（onadded）。飛ばしたものがあれば、閉じずに結果をダイアログの中に残し
  // （読む前に消えないように）、一覧を読み直す。1件も入らなかったときは成功の印を付けない。
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
  type Outcome = { added: number; skipped: { completed: number; unavailable: number; already: number } };

  const ids = $props.id();
  const formId = `${ids}-form`;
  const listLabelId = `${ids}-list`;
  const hintId = `${ids}-hint`;

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let searchInput = $state<HTMLInputElement>();
  let sprint = $state<SprintSummary | null>(null);
  let groups = $state<Group[]>([]);
  let loading = $state(false);
  let loadFailed = $state(false);
  let submitting = $state(false);
  let submitError = $state<string | null>(null);
  // 飛ばしたものがあったときの結果。ダイアログの中に残す
  let outcome = $state<Outcome | null>(null);
  let query = $state('');
  const picked = new SvelteSet<string>();
  // 開き直しで進める。古い応答が、今の状態を上書きしない
  let generation = 0;

  export function show(trigger: HTMLElement | null, target: SprintSummary): void {
    generation++;
    sprint = target;
    groups = [];
    picked.clear();
    query = '';
    outcome = null;
    submitError = null;
    submitting = false;
    loadFailed = false;
    // 前に開いたときの読み込みが続いていても、その応答は generation で捨てるので、ここで読み直せるようにする
    loading = false;
    dialog?.show(trigger);
    void load(false);
  }

  // 読めなかったときは、枠と「もう一度試す」を残したまま読み直す（読んでいる間もボタンを残して aria-disabled）。
  // focus が真なら、読めたら最初の入力（検索欄）へフォーカスを移す
  async function load(focus: boolean): Promise<void> {
    const mine = generation;
    const target = sprint;
    if (target === null || loading) return;
    loading = true;
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
    loadFailed = false;
    // このスプリントに入っていない未完了のタスクだけ。木の順（エピックの下のストーリー、親のないストーリー、親のないタスク）
    const outside = (tasks: readonly BacklogTask[]) => tasks.filter((task) => task.sprint?.id !== target.id);
    const stories = [...result.data.epics.flatMap((epic) => epic.stories), ...result.data.stories].filter(
      (story) => story.completed_at === null,
    );
    groups = [
      ...stories.map((story) => ({ id: story.id, title: story.title, tasks: outside(story.tasks) })),
      { id: null, title: t('sprintTaskAddRootTasks', { task: t('task') }), tasks: outside(result.data.tasks) },
    ].filter((group) => group.tasks.length > 0);
    // 読み直した一覧に無くなったタスクは選びから外す
    const shown = new Set(groups.flatMap((group) => group.tasks.map((task) => task.id)));
    for (const id of [...picked]) if (!shown.has(id)) picked.delete(id);
    if (focus) {
      await tick();
      searchInput?.focus();
    }
  }

  // 検索の語（空白で区切る）。題が語をすべて含めば当たる（英字の大文字と小文字は区別しない）
  const words = $derived(
    query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word !== ''),
  );
  const hits = (title: string) => words.every((word) => title.toLowerCase().includes(word));
  // 絞った見え方。ストーリーの題が当たれば配下を全部、そうでなければ題の当たるタスクだけ
  const visibleGroups = $derived(
    groups
      .map((group) => ({
        ...group,
        shown:
          words.length === 0 || (group.id !== null && hits(group.title))
            ? group.tasks
            : group.tasks.filter((task) => hits(task.title)),
      }))
      .filter((group) => group.shown.length > 0),
  );

  // 送るタスクの ID。木の順
  const chosen = $derived(
    groups.flatMap((group) => group.tasks.filter((task) => picked.has(task.id)).map((task) => task.id)),
  );
  const tooMany = $derived(chosen.length > SPRINT_TASK_ADD_MAX);
  // 選んだタスクのうち、決まった欄が未記入のもの（木のタスクは完了していないものだけ）。入れる操作は止めない
  const unfilledChosen = $derived(
    groups.flatMap((group) => group.tasks.filter((task) => picked.has(task.id) && task.unfilled)).length,
  );
  const ready = $derived(!loading && !loadFailed && sprint !== null);

  // 見出しのチェックが見るのは、見えている配下（shown）だけ。絞っている間に、見えないタスクまで選ばないため
  type VisibleGroup = Group & { shown: BacklogTask[] };

  function groupState(group: VisibleGroup): 'all' | 'some' | 'none' {
    const count = group.shown.filter((task) => picked.has(task.id)).length;
    return count === 0 ? 'none' : count === group.shown.length ? 'all' : 'some';
  }

  function toggleGroup(group: VisibleGroup, checked: boolean): void {
    for (const task of group.shown) {
      if (checked) picked.add(task.id);
      else picked.delete(task.id);
    }
    submitError = null;
  }

  function toggleTask(id: string, checked: boolean): void {
    if (checked) picked.add(id);
    else picked.delete(id);
    submitError = null;
  }

  // 見出しのチェックボックスの、一部だけ選んだ印（indeterminate は属性ではなく DOM の値なので、ここで入れる）
  function partial(group: VisibleGroup) {
    return (node: HTMLInputElement) => {
      node.indeterminate = groupState(group) === 'some';
    };
  }

  function taskMeta(task: BacklogTask): string {
    // 親のストーリーの題は見出しにあるので、繰り返さない
    const parts = [
      task.points === null ? t('pointsUnsetTitle') : t('pointsLabel', { points: t('points'), value: task.points }),
    ];
    if (task.sprint !== null) parts.push(t('sprintTaskAddInSprint', { label: sprintLabel(task.sprint, t) }));
    if (task.unfilled) parts.push(t('sprintTaskPickRowUnfilled', { detail: t('detail') }));
    return parts.join('・');
  }

  function outcomeText(result: Outcome): string {
    const { skipped } = result;
    const parts = [t('sprintTaskAdded', { count: result.added })];
    if (skipped.completed > 0)
      parts.push(t('sprintTaskSkippedCompleted', { count: skipped.completed, done: t('done') }));
    if (skipped.unavailable > 0) parts.push(t('sprintTaskSkippedUnavailable', { count: skipped.unavailable }));
    if (skipped.already > 0) parts.push(t('sprintTaskSkippedAlready', { count: skipped.already }));
    return parts.join('。');
  }

  // 1件も入らなかった。どれも読み直さないと直らないので、トーストで知らせて閉じ、画面が読み直す
  function failed(message: string): void {
    open = false;
    showToast(message, 'alert');
    onadded();
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    // 読んでいる間と、読めなかった間は送らない（選んでいないことの知らせも出さない）
    if (submitting || !ready || sprint === null) return;
    if (chosen.length === 0) {
      submitError = t('sprintTaskAddNoneSelected', { task: t('task'), story: t('story') });
      return;
    }
    if (tooMany) return;
    const mine = generation;
    submitting = true;
    submitError = null;
    outcome = null;
    try {
      const result = await callOperation(
        sprintTaskAdd,
        { workspace_id: workspaceId, sprint_id: sprint.id, task_ids: chosen },
        { slug },
      );
      if (mine !== generation) return;
      if (result.ok) {
        const { skipped } = result.data;
        onadded();
        if (skipped.completed + skipped.unavailable + skipped.already === 0) {
          open = false;
          showToast(outcomeText(result.data), 'check');
          return;
        }
        // 飛ばしたものがあれば、閉じずに結果を残し、一覧を読み直す（入ったものは一覧から消える）
        outcome = result.data;
        picked.clear();
        void load(false);
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

  // 読み上げる文は、常に置いた status の領域に入れる（文と一緒に差し込んだ status の領域は、読み上げられないことがある）
  const status = $derived(
    submitting
      ? t('sprintTaskAdding')
      : loading && !loadFailed
        ? t('loading')
        : outcome !== null
          ? outcomeText(outcome)
          : '',
  );
  const title = $derived(sprint === null ? '' : t('sprintTaskAddTitle', { label: sprintLabel(sprint, t) }));
</script>

<Dialog bind:this={dialog} bind:open dismissible={!submitting} {title}>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    <p class="field-hint" id={hintId}>
      {t('sprintTaskAddHint', { story: t('story'), task: t('task'), sprint: t('sprint') })}
    </p>
    {#if outcome !== null}
      <div class="callout" class:is-ok={outcome.added > 0} class:is-warn={outcome.added === 0}>
        <Icon name={outcome.added > 0 ? 'check' : 'alert'} /><span>{outcomeText(outcome)}</span>
      </div>
    {/if}
    <label class="search"
      ><Icon name="search" /><input
        type="search"
        bind:this={searchInput}
        bind:value={query}
        onkeydown={(event) => {
          // 検索欄の Enter で、選んだものを送らない（入れるのは主ボタンだけ）
          if (event.key === 'Enter' && !event.isComposing) event.preventDefault();
        }}
        aria-label={t('sprintTaskPickSearch', { task: t('task'), story: t('story') })}
        placeholder={t('sprintTaskPickSearchPlaceholder')}
        autocomplete="off"
      /></label
    >
    {#if loadFailed}
      <div class="callout is-warn">
        <Icon name="alert" /><span role="alert">{t('sprintTaskTreeFailed', { backlog: t('backlog') })}</span>
        <div class="callout-actions">
          <button class="btn is-sm" type="button" aria-disabled={loading} onclick={() => !loading && void load(true)}
            >{loading ? t('retrying') : t('retry')}</button
          >
        </div>
      </div>
    {:else if loading}
      <p class="action-note">{t('loading')}</p>
    {:else if groups.length === 0}
      <p class="action-note">{t('sprintTaskAddNothing', { task: t('task'), backlog: t('backlog') })}</p>
    {:else}
      <span class="visually-hidden" id={listLabelId}>{t('sprintTaskPickListLabel', { task: t('task') })}</span>
      <fieldset class="form-fields" disabled={submitting}>
        <div class="pick-list" role="group" aria-labelledby={listLabelId} aria-describedby={hintId}>
          {#each visibleGroups as group (group.id ?? '')}
            {@const state = groupState(group)}
            <div class="pick-group">
              {#if group.id !== null}
                <label class="pick-row is-head">
                  <input
                    type="checkbox"
                    checked={state === 'all'}
                    {@attach partial(group)}
                    onchange={(event) => toggleGroup(group, event.currentTarget.checked)}
                  />
                  <span
                    >{group.title}<span class="pick-meta"
                      >{t('sprintTaskAddStoryMeta', { task: t('task'), count: group.shown.length })}</span
                    ></span
                  >
                </label>
              {:else}
                <div class="pick-row is-head"><span>{group.title}</span></div>
              {/if}
              {#each group.shown as task (task.id)}
                {@const meta = taskMeta(task)}
                <label class="pick-row is-child">
                  <input
                    type="checkbox"
                    checked={picked.has(task.id)}
                    onchange={(event) => toggleTask(task.id, event.currentTarget.checked)}
                  />
                  <span
                    >{task.title}{#if meta !== ''}<span class="pick-meta">{meta}</span>{/if}</span
                  >
                </label>
              {/each}
            </div>
          {:else}
            <p class="pick-empty">{t('sprintTaskPickNoMatch', { task: t('task') })}</p>
          {/each}
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
    {#if ready && groups.length > 0}
      <span class="pick-count"
        >{t('sprintTaskPickCount', { count: chosen.length })}{#if unfilledChosen > 0}
          <span data-pick-unfilled>{t('sprintTaskPickUnfilled', { detail: t('detail'), count: unfilledChosen })}</span
          >{/if}</span
      >
    {/if}
    <button class="btn is-quiet" type="button" aria-disabled={submitting} onclick={close}>{t('cancel')}</button>
    <button
      class="btn is-primary"
      type="submit"
      form={formId}
      aria-disabled={submitting || !ready || chosen.length === 0 || tooMany}
    >
      {submitting
        ? t('sprintTaskAdding')
        : chosen.length === 0
          ? t('sprintTaskAddSubmitEmpty')
          : t('sprintTaskAddSubmit', { count: chosen.length })}
    </button>
  {/snippet}
</Dialog>
