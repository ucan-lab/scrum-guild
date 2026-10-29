<script lang="ts">
  import { tick } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import {
    sprintClose,
    sprintCloseConflictReasonOf,
    sprintList,
    type SprintPlan,
    type SprintSummary,
  } from '../../shared/operations/sprint/index.ts';
  import { callOperation } from '../api.ts';
  import { sprintLabel, sprintLabelWithPeriod } from '../sprint-label.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // スプリントを終えるダイアログ（kit.js の DIALOGS.sprintEnd）。開くたびに sprint-list を読み、終えるスプリントの未完了のタスクの件数と、
  // 持ち越し先の候補（終えるスプリントの最終日より後に始まり、最終日がワークスペースの今日以降の、先のスプリント）を出す。
  // 未完了のタスクがあるときだけ行き先（候補ごとの「持ち越す」と「バックログへ戻す」）を聞き、既定は最も早い候補（無ければバックログだけ）。
  // ゴールを書いて始めたスプリントだけ、達成したかを聞く（既定は「達成した」）。
  // 読み込みが終わったら、フォーカスを選ばれている行き先（無ければゴールの達成、どちらも無ければ見出し）へ移す。
  // 読み込めなかったときは「終える」を押せない。
  // 持ち越し先が使えなくなった（carry_target、持ち越し先が消えた 404）、読んでから書くまでにタスクが変わった（changed）、
  // 入力が合わない（400）ときは、理由をダイアログの中に出して開いたままにし、候補と件数を読み直す。
  // 読み直して終えるスプリントが進行中でなければ（not_active、終えるスプリントが消えた 404）、トーストで知らせて閉じ、画面を読み直す（ongone）。
  // 閉じたワークスペース、権限が無い（403）ときは、ダイアログの中に出し、閉じたら画面を読み直す。
  // 開いた後に入ったタスクも、サーバーが読み直して同じ行き先へ持ち越す。未完了が0件で行き先を聞かなかったときは、バックログへ戻る。
  // 件数は終えたときのトーストで分かるので、ダイアログの中では知らせない。
  // 終えられたら閉じて、画面が読み直す（onclosed）
  let {
    slug,
    workspaceId,
    onclosed,
    ongone,
  }: {
    slug: string;
    workspaceId: string;
    // 終えたスプリントの ID を渡す（押した「終える」は画面から消えるので、画面がフォーカスの行き先を決める）
    onclosed: (sprintId: string) => void;
    ongone: () => void;
  } = $props();

  const ids = $props.id();
  const formId = `${ids}-form`;
  const carryName = `${ids}-carry`;
  const goalName = `${ids}-goal`;
  const carryLegendId = `${ids}-carry-legend`;
  const goalLegendId = `${ids}-goal-legend`;

  // バックログへ戻す選択肢の値。スプリントの ID（UUID）とは重ならない
  const BACKLOG = 'backlog';

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let submitButton = $state<HTMLButtonElement>();

  let target = $state<SprintSummary | null>(null);
  let current = $state<SprintPlan | null>(null);
  let candidates = $state<SprintPlan[]>([]);
  let loading = $state(false);
  let loadFailed = $state(false);
  let carry = $state(BACKLOG);
  // 行き先を人が選んだか（読み直しで既定に戻さないため）
  let chosenByUser = $state(false);
  let goalAchieved = $state<'yes' | 'no'>('yes');
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

  export function show(trigger: HTMLElement | null, sprint: SprintSummary): void {
    generation++;
    reloadOnClose = false;
    target = sprint;
    current = null;
    candidates = [];
    loadFailed = false;
    loading = false;
    carry = BACKLOG;
    chosenByUser = false;
    goalAchieved = 'yes';
    submitError = null;
    submitting = false;
    dialog?.show(trigger);
    void load();
  }

  // 終えるスプリントの今の状態と持ち越し先の候補を読む。進行中でなくなっていれば、閉じて画面を読み直す。
  // 選んでいた行き先が候補から消えたら、既定に戻す
  async function load(): Promise<void> {
    const mine = generation;
    const sprint = target;
    if (sprint === null || loading) return;
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
    const found = result.data.sprints.find((candidate) => candidate.id === sprint.id);
    if (found === undefined || found.status !== 'active') {
      gone(t('sprintCloseNotActive', { sprint: t('sprint') }));
      return;
    }
    current = found;
    // sprint-list は開始日の順。最も早い候補が先頭に来る。最終日がワークスペースの今日より前の先のスプリントは、
    // 始められないので候補にしない（サーバーも 409 の carry_target で断る）
    candidates = result.data.sprints.filter(
      (candidate) =>
        candidate.status === 'planned' && candidate.start_on > found.end_on && candidate.end_on >= result.data.today,
    );
    if (carry !== BACKLOG && !candidates.some((candidate) => candidate.id === carry)) {
      carry = BACKLOG;
      chosenByUser = false;
    }
    if (carry === BACKLOG && !chosenByUser) carry = candidates[0]?.id ?? BACKLOG;
    await focusAnswer(mine);
  }

  // 読み込みが終わったら、フォーカスを答える欄へ移す（開いた直後は、読み込み前の主ボタンに落ちている）。
  // 選ばれている行き先、行き先を聞かないときはゴールの達成、どちらも無ければダイアログの見出し
  async function focusAnswer(mine: number): Promise<void> {
    await tick();
    if (mine !== generation) return;
    const form = document.getElementById(formId);
    const answer =
      form?.querySelector<HTMLElement>(`input[name="${carryName}"]:checked`) ??
      form?.querySelector<HTMLElement>(`input[name="${goalName}"]:checked`) ??
      form?.closest('dialog')?.querySelector<HTMLElement>('.dialog-title');
    if (answer === null || answer === undefined) return;
    if (!answer.hasAttribute('tabindex') && answer.tagName === 'H2') answer.setAttribute('tabindex', '-1');
    answer.focus();
  }

  const openCount = $derived((current?.tasks ?? []).filter((task) => task.completed_at === null).length);
  const hasGoal = $derived(current !== null && current.goal !== null);
  const status = $derived(submitting ? t('sprintClosing') : '');

  function gone(message: string): void {
    open = false;
    showToast(message, 'alert');
    ongone();
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting || loading || loadFailed || target === null || current === null) return;
    const mine = generation;
    submitting = true;
    submitError = null;
    submitButton?.focus();
    try {
      const result = await callOperation(
        sprintClose,
        {
          workspace_id: workspaceId,
          sprint_id: target.id,
          // 未完了のタスクが無ければ、行き先は聞かない（バックログと同じに送る）
          carry_sprint_id: openCount === 0 || carry === BACKLOG ? null : carry,
          is_goal_achieved: hasGoal ? goalAchieved === 'yes' : null,
        },
        { slug },
      );
      if (mine !== generation) return;
      if (!result.ok) {
        if (result.status === 401) {
          await invalidateAll();
          return;
        }
        const reason =
          result.error?.code === 'conflict' ? sprintCloseConflictReasonOf(result.error.details) : undefined;
        if (reason === 'not_active') {
          gone(t('sprintCloseNotActive', { sprint: t('sprint') }));
        } else if (reason === 'carry_target') {
          submitError = t('sprintCloseCarryTarget');
          chosenByUser = false;
          submitting = false;
          await load();
        } else if (reason === 'changed') {
          submitError = t('sprintCloseChanged', { task: t('task') });
          submitting = false;
          await load();
        } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
          submitError = t('workspaceClosedReadOnly', { workspace: t('workspace') });
          reloadOnClose = true;
        } else if (result.status === 404) {
          // 終えるスプリントか持ち越し先が消えた。読み直して、終えるスプリントが進行中のままなら（持ち越し先が消えた）、
          // 開いたまま選び直させる。終えるスプリントが無いか進行中でなければ、load が知らせて閉じる
          submitError = t('sprintCloseCarryTarget');
          chosenByUser = false;
          submitting = false;
          await load();
        } else if (result.status === 403) {
          submitError = t('sprintCloseForbidden', { sprint: t('sprint'), leader: t('leader') });
          reloadOnClose = true;
        } else if (result.status === 400) {
          // ゴールの有無が読んだときと合わない。読み直して聞き直す
          submitError = t('sprintBadRequest');
          submitting = false;
          await load();
        } else {
          submitError = t('sprintCloseFailed');
        }
        return;
      }
      open = false;
      const label = sprintLabel(target, t);
      const carryTo = result.data.carry_to;
      showToast(
        result.data.carried_count === 0
          ? t('sprintClosedNone', { label })
          : carryTo === null
            ? t('sprintClosedToBacklog', {
                label,
                task: t('task'),
                count: result.data.carried_count,
                backlog: t('backlog'),
              })
            : t('sprintClosedToSprint', {
                label,
                task: t('task'),
                count: result.data.carried_count,
                target: sprintLabel(carryTo, t),
              }),
        'check',
      );
      onclosed(target.id);
    } finally {
      if (mine === generation) submitting = false;
    }
  }
</script>

<Dialog bind:this={dialog} bind:open dismissible={!submitting} title={t('sprintCloseTitle', { sprint: t('sprint') })}>
  {#if target !== null}
    <form id={formId} class="form" onsubmit={submit} novalidate>
      <p>
        {t('sprintCloseText', { label: sprintLabelWithPeriod(target, t), sprint: t('sprint') })}
      </p>
      {#if loadFailed}
        <div class="callout is-danger" role="alert">
          <Icon name="alert" /><span>{t('sprintCloseLoadFailed', { sprint: t('sprint') })}</span>
          <div class="callout-actions">
            <button class="btn is-sm" type="button" aria-disabled={loading} onclick={() => !loading && void load()}
              >{loading ? t('retrying') : t('retry')}</button
            >
          </div>
        </div>
      {:else if current === null}
        <p class="props-note" role="status">{t('loading')}</p>
      {:else}
        <fieldset class="form-fields" disabled={submitting}>
          {#if openCount > 0}
            <div class="field">
              <span class="field-label" id={carryLegendId}
                >{t('sprintCloseCarryLegend', { task: t('task'), count: openCount })}</span
              >
              <div class="choice-list" role="radiogroup" aria-labelledby={carryLegendId}>
                {#each candidates as candidate (candidate.id)}
                  <label class="choice">
                    <input
                      type="radio"
                      name={carryName}
                      value={candidate.id}
                      bind:group={carry}
                      onchange={() => (chosenByUser = true)}
                    />
                    <div>
                      <b>{t('sprintCloseCarryTo', { label: sprintLabelWithPeriod(candidate, t) })}</b>
                      <span>{t('sprintCloseCarryToNote', { task: t('task') })}</span>
                    </div>
                  </label>
                {/each}
                <label class="choice">
                  <input
                    type="radio"
                    name={carryName}
                    value={BACKLOG}
                    bind:group={carry}
                    onchange={() => (chosenByUser = true)}
                  />
                  <div>
                    <b>{t('sprintCloseCarryBacklog', { backlog: t('backlog') })}</b>
                    <span>{t('sprintCloseCarryBacklogNote', { sprint: t('sprint') })}</span>
                  </div>
                </label>
              </div>
              {#if candidates.length === 0}
                <span class="field-hint"
                  >{t('sprintCloseCarryNoTarget', { sprint: t('sprint'), backlog: t('backlog') })}</span
                >
              {/if}
            </div>
          {:else}
            <p class="props-note">{t('sprintCloseNoOpen', { task: t('task') })}</p>
          {/if}
          {#if hasGoal}
            <div class="field">
              <span class="field-label" id={goalLegendId}
                >{t('sprintCloseGoalLegend', { sprintGoal: t('sprintGoal') })}</span
              >
              <p class="props-note">{current.goal}</p>
              <div class="segmented" role="radiogroup" aria-labelledby={goalLegendId}>
                <label>
                  <input type="radio" name={goalName} value="yes" bind:group={goalAchieved} />
                  <span>{t('sprintCloseGoalAchieved')}</span>
                </label>
                <label>
                  <input type="radio" name={goalName} value="no" bind:group={goalAchieved} />
                  <span>{t('sprintCloseGoalMissed')}</span>
                </label>
              </div>
            </div>
          {/if}
        </fieldset>
      {/if}
      {#if submitError !== null}
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
      aria-disabled={submitting || loading || loadFailed || current === null}
      bind:this={submitButton}
    >
      {submitting ? status : t('sprintCloseSubmit')}
    </button>
  {/snippet}
</Dialog>
