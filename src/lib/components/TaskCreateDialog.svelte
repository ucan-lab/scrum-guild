<script lang="ts">
  import { tick } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { taskCreate } from '../../shared/operations/task/index.ts';
  import { memberList } from '../../shared/operations/workspace/index.ts';
  import type { BacklogTask } from '../../shared/operations/task/backlog-tree.ts';
  import {
    TASK_POINT_VALUES,
    TASK_TITLE_MAX_LENGTH,
    taskTitleProblem,
    type TaskTitleProblem,
  } from '../../shared/task.ts';
  import { callOperation } from '../api.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // kit.js の createTask。タイトル、親のストーリー、担当、ポイント。リポジトリ、添付ファイルは、それぞれの機能の Issue で足す。
  // 親の選択欄は、親なしと、stories（画面が渡す、完了していない親のないストーリー）。show(trigger, storyId) で親を選んだ状態で開ける。
  // 担当の選択欄は、担当なし（既定）と、開くたびに member-list で読む、そのワークスペースに今所属している人。
  // 読めなければ担当なしだけで作れ、読めなかったことを添える。選んだ人が所属を外れていた（404）ときは、理由を出し、候補を読み直して
  // 担当なしに戻し、担当の選択欄へフォーカスを移す。
  // 送っている間は、「作る」を押しても無視し（aria-disabled）、ダイアログも閉じられない。二重送信はそれだけで防ぐ。
  // 作れたら閉じて、作ったタスクと親の ID を oncreated に渡す（画面が親の配下か一覧の末尾に足す）。
  // 親が消えた（404）か完了した（409）ときは、理由を出し、その場で木を読み直して候補を更新する（選んでいた親が消えたら親なしに戻し、親の選択欄へフォーカスを移す）。
  // 送り始めた後に部品が外れた（画面を離れた、ワークスペースが替わった）ときは、古い応答で状態を更新しない（generation）
  let {
    slug,
    workspaceId,
    stories,
    oncreated,
  }: {
    slug: string;
    workspaceId: string;
    stories: readonly { id: string; title: string }[];
    oncreated: (task: BacklogTask, storyId: string | null) => void;
  } = $props();

  type PointsChoice = (typeof TASK_POINT_VALUES)[number] | null;
  // 先頭が「未」（未見積もり）
  const pointChoices: readonly PointsChoice[] = [null, ...TASK_POINT_VALUES];

  const ids = $props.id();
  const formId = `${ids}-form`;
  const titleId = `${ids}-title`;
  const titleErrorId = `${ids}-title-error`;
  const parentId = `${ids}-parent`;
  const assigneeId = `${ids}-assignee`;
  const assigneeNoteId = `${ids}-assignee-note`;
  const pointsLabelId = `${ids}-points`;
  const pointsHintId = `${ids}-points-hint`;

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let titleInput = $state<HTMLInputElement>();
  let submitButton = $state<HTMLButtonElement>();
  let parentSelect = $state<HTMLSelectElement>();
  let assigneeSelect = $state<HTMLSelectElement>();

  let title = $state('');
  let points = $state<PointsChoice>(null);
  // 選んだ親のストーリーの ID。空は親なし
  let story = $state('');
  // 選んだ担当の ID。空は担当なし
  let assignee = $state('');
  // 担当の候補（そのワークスペースに今所属している人）。読み込む前と読めなかったときは空
  let candidates = $state<readonly { id: string; name: string }[]>([]);
  let candidatesFailed = $state(false);
  let titleError = $state<string | null>(null);
  let submitError = $state<string | null>(null);
  let submitting = $state(false);

  // 開き直しと部品の取り外しで進める。古い応答が、今の状態を上書きしない
  let generation = 0;

  // 閉じたワークスペースだと分かったら、ダイアログを閉じたときに画面を読み直す。
  // すぐに読み直すと、ダイアログごと外れて理由の文を読めなくなるため
  let reloadOnClose = false;
  $effect(() => {
    if (open || !reloadOnClose) return;
    reloadOnClose = false;
    void invalidateAll();
  });

  // ワークスペースが替わったら、開いたままにしない
  const currentWorkspaceId = $derived(workspaceId);
  $effect(() => {
    void currentWorkspaceId;
    return () => {
      generation++;
      submitting = false;
      open = false;
    };
  });

  export function show(trigger?: HTMLElement | null, storyId: string | null = null): void {
    generation++;
    reloadOnClose = false;
    title = '';
    points = null;
    // 候補に無い親（完了した、消えた）は選ばず、親なしで開く
    story = storyId !== null && stories.some((candidate) => candidate.id === storyId) ? storyId : '';
    assignee = '';
    // 前に開いたとき（別のワークスペースのときを含む）の候補と、読めなかった知らせを残さない
    candidates = [];
    candidatesFailed = false;
    titleError = null;
    submitError = null;
    submitting = false;
    dialog?.show(trigger);
    void loadCandidates(generation);
  }

  // 担当の候補を読む。開き直した後と部品が外れた後の応答と、後から読み直した分より古い応答は捨てる。
  // 選んでいた人が候補から消えたら、担当なしに戻す
  let candidatesVersion = 0;
  let candidatesLoading = $state(false);
  async function loadCandidates(mine: number): Promise<void> {
    const version = ++candidatesVersion;
    candidatesLoading = true;
    const result = await callOperation(memberList, { workspace_id: workspaceId }, { slug });
    if (mine !== generation || version !== candidatesVersion) return;
    candidatesLoading = false;
    if (!result.ok) {
      candidatesFailed = true;
      return;
    }
    candidates = result.data.members.map((member) => ({ id: member.id, name: member.name }));
    candidatesFailed = false;
    if (assignee !== '' && !candidates.some((candidate) => candidate.id === assignee)) assignee = '';
  }

  // 候補を読み直す。読めたら、押したボタンは消えるので、担当の選択欄へフォーカスを移す
  async function retryCandidates(): Promise<void> {
    if (candidatesLoading) return;
    const mine = generation;
    await loadCandidates(mine);
    if (mine !== generation || candidatesFailed) return;
    await tick();
    assigneeSelect?.focus();
  }

  // 木を読み直して、親の候補を更新する。選んでいた親が候補から消えたら、親なしに戻して true を返す
  async function reloadParents(mine: number): Promise<boolean> {
    const chosen = story;
    await invalidateAll();
    if (mine !== generation || chosen === '') return false;
    if (stories.some((candidate) => candidate.id === chosen)) return false;
    story = '';
    return true;
  }

  const titleMessages = $derived<Record<TaskTitleProblem, string>>({
    required: t('taskTitleRequired'),
    too_long: t('taskTitleTooLong', { max: TASK_TITLE_MAX_LENGTH }),
    invalid_character: t('taskTitleInvalidCharacter'),
  });

  function titleProblemMessage(): string | null {
    const problem = taskTitleProblem(title.trim());
    return problem === null ? null : titleMessages[problem];
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    titleError = titleProblemMessage();
    if (titleError !== null) {
      titleInput?.focus();
      return;
    }
    const mine = generation;
    submitting = true;
    submitError = null;
    // 欄が disabled になるので、Enter で送ったときもフォーカスを失わないよう、「作る」へ移す
    submitButton?.focus();
    let focusTitle = false;
    let focusParent = false;
    let focusAssignee = false;
    try {
      const result = await callOperation(
        taskCreate,
        {
          workspace_id: workspaceId,
          title: title.trim(),
          points,
          assignee_user_id: assignee === '' ? null : assignee,
          story_id: story === '' ? null : story,
        },
        { slug },
      );
      if (mine !== generation) return;
      if (!result.ok) {
        if (result.status === 401) {
          // セッションが切れた。枠の読み直しがログインの画面へ移す
          await invalidateAll();
          return;
        }
        if (result.status === 409 && result.error?.code === 'workspace_closed') {
          submitError = t('workspaceClosedReadOnly', { workspace: t('workspace') });
          // 閉じたら画面を読み直して、閉じた表示（起票と完了の操作を出さない）に切り替える
          reloadOnClose = true;
        } else if (story !== '' && result.status === 409 && result.error?.code === 'conflict') {
          // 親が完了した。理由を出し、その場で木を読み直して候補を更新する。選んでいた親が候補から消えたら、親なしに戻して、
          // 選び直せるよう親の選択欄へフォーカスを移す（ダイアログは閉じない）
          submitError = t('taskParentDone', { story: t('story'), done: t('done') });
          focusParent = await reloadParents(mine);
        } else if (result.status === 404 && (story !== '' || assignee !== '')) {
          // 親が消えたか、担当が所属を外れた。親を選んでいれば木を読み直し、親が候補から消えていれば親の理由を出す。
          // 親が無事で担当を選んでいれば、担当の理由を出し、候補を読み直して担当なしに戻し、担当の選択欄へフォーカスを移す
          const parentGone = story !== '' && (await reloadParents(mine));
          if (mine !== generation) return;
          if (parentGone || assignee === '') {
            submitError = t('taskParentGone', { story: t('story') });
            focusParent = parentGone;
          } else {
            submitError = t('assigneeNotMember', { workspace: t('workspace'), assignee: t('assignee') });
            assignee = '';
            focusAssignee = true;
            await loadCandidates(mine);
            if (mine !== generation) return;
          }
        } else if (result.status === 400) {
          // 画面の検査を通った後に断られたのは、タイトルだけ（ポイントは選ぶ形）
          titleError = t('taskTitleInvalidCharacter');
          focusTitle = true;
        } else {
          submitError = t('taskCreateFailed');
        }
        return;
      }
      const parent = stories.find((candidate) => candidate.id === story) ?? null;
      open = false;
      oncreated(result.data.task, parent?.id ?? null);
      showToast(
        parent === null
          ? t('taskCreated', { backlog: t('backlog') })
          : t('taskCreatedUnder', { story: t('story'), title: parent.title }),
        'check',
      );
    } finally {
      if (mine === generation) {
        submitting = false;
        if (focusTitle || focusParent || focusAssignee) {
          await tick();
          (focusAssignee ? assigneeSelect : focusParent ? parentSelect : titleInput)?.focus();
        }
      }
    }
  }

  // 状態を読み上げに伝える。領域は常に置き、中の文字だけを替える
  const status = $derived(submitting ? t('taskSubmitting') : '');
</script>

<Dialog bind:this={dialog} bind:open dismissible={!submitting} title={t('create')}>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    <!-- 送っている間は、欄も変えられない。「作る」はフォーカスを残すため、欄のまとまりの外で aria-disabled にしている -->
    <fieldset class="form-fields" disabled={submitting}>
      <div class="field" class:is-invalid={titleError !== null}>
        <label class="field-label" for={titleId}>{t('fieldTitle')}</label>
        <input
          class="input"
          id={titleId}
          bind:this={titleInput}
          bind:value={title}
          oninput={() => (titleError = null)}
          placeholder={t('taskTitlePlaceholder')}
          autocomplete="off"
          aria-invalid={titleError !== null}
          aria-describedby={titleError !== null ? titleErrorId : undefined}
        />
        {#if titleError !== null}
          <span class="field-error" id={titleErrorId} role="alert"><Icon name="alert" />{titleError}</span>
        {/if}
      </div>

      <!-- 片方の下にだけ知らせが出ても、もう片方の欄が下へずれないよう、上で揃える -->
      <div class="form-row is-start">
        <div class="field">
          <label class="field-label" for={parentId}>{t('taskParent', { story: t('story') })}</label>
          <select class="select" id={parentId} bind:this={parentSelect} bind:value={story}>
            <option value="">{t('taskParentNone')}</option>
            {#each stories as option (option.id)}
              <option value={option.id}>{option.title}</option>
            {/each}
          </select>
        </div>
        <div class="field">
          <label class="field-label" for={assigneeId}>{t('assignee')}</label>
          <select
            class="select"
            id={assigneeId}
            bind:this={assigneeSelect}
            bind:value={assignee}
            aria-busy={candidatesLoading}
            aria-describedby={candidatesFailed ? assigneeNoteId : undefined}
          >
            <option value="">{t('unassigned')}</option>
            {#each candidates as option (option.id)}
              <option value={option.id}>{option.name}</option>
            {/each}
          </select>
          {#if candidatesLoading && !candidatesFailed}
            <!-- 候補を読んでいる間は、選択肢が担当なしだけなので、まだ読んでいることを示す -->
            <span class="field-hint" role="status">{t('loading')}</span>
          {/if}
          {#if candidatesFailed}
            <span class="field-hint" id={assigneeNoteId}
              >{t('assigneeCandidatesFailed', { assignee: t('assignee') })}</span
            >
            <div class="form-actions">
              <button
                class="btn is-sm is-quiet"
                type="button"
                aria-disabled={candidatesLoading}
                onclick={() => void retryCandidates()}
              >
                {candidatesLoading ? t('retrying') : t('retry')}
              </button>
            </div>
          {/if}
        </div>
      </div>

      <div class="field">
        <span class="field-label" id={pointsLabelId}>{t('points')}</span>
        <div class="segmented" role="radiogroup" aria-labelledby={pointsLabelId} aria-describedby={pointsHintId}>
          {#each pointChoices as choice (choice)}
            <label>
              <input
                type="radio"
                name="{ids}-points"
                value={choice}
                bind:group={points}
                aria-label={choice === null ? t('pointsUnsetTitle') : undefined}
              />
              <span>{choice === null ? t('pointsUnsetMark') : choice}</span>
            </label>
          {/each}
        </div>
        <span class="field-hint" id={pointsHintId}>
          {t('taskPointsHint', { points: t('points'), task: t('task'), done: t('done') })}
        </span>
      </div>
    </fieldset>

    {#if submitError !== null}
      <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{submitError}</span></div>
    {/if}
  </form>
  <!-- 状態の読み上げの領域。form の外に常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{status}</span>
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" aria-disabled={submitting} onclick={close}>{t('cancel')}</button>
    <button class="btn is-primary" type="submit" form={formId} aria-disabled={submitting} bind:this={submitButton}>
      {submitting ? t('taskSubmitting') : t('create')}
    </button>
  {/snippet}
</Dialog>
