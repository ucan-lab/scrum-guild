<script lang="ts">
  import { tick } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { epicRequesterUpdate } from '../../shared/operations/epic/index.ts';
  import { memberList } from '../../shared/operations/workspace/index.ts';
  import { callOperation } from '../api.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // 依頼主を替えるダイアログ（エピックの画面の「<依頼主>を替える」。リーダー（管理者を含む）だけに出る）。
  // 候補は、開くたびに member-list で読む、そのワークスペースに今所属している人のうち、今の依頼主（requesterId。画面が渡す）でない人。
  // 1人を選んで「替える」を押すと epic-requester-update を送る。討伐隊は変わらない。
  // 替えられたら閉じて、トーストで知らせ、onchanged で画面に読み直させる（別の画面で先に同じ人になっていたときも、閉じてその旨を知らせる）。
  // 選んだ人が所属を外れていた、エピックが消えた（404）ときは、理由を出し、候補を読み直す。終わったエピック（409 の conflict）、
  // 権限が無い（403）は理由を出し、閉じたときに画面を読み直す。閉じたワークスペース（409 の workspace_closed）は理由を出し、
  // 閉じたときに枠ごと読み直す。
  // 送っている間は「替える」を押しても無視し（aria-disabled）、ダイアログも閉じられない。
  // 送り始めた後に開き直した、部品が外れたときは、古い応答で状態を更新しない（generation）
  let {
    slug,
    workspaceId,
    epicId,
    requesterId,
    onchanged,
  }: {
    slug: string;
    workspaceId: string;
    epicId: string;
    requesterId: string;
    onchanged: () => void;
  } = $props();

  const ids = $props.id();
  const formId = `${ids}-form`;
  const selectId = `${ids}-member`;
  const hintId = `${ids}-hint`;

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let select = $state<HTMLSelectElement>();
  let submitButton = $state<HTMLButtonElement>();

  // 今所属している人（読む前と読めなかったときは空）。候補は、そのうち今の依頼主でない人
  let members = $state<readonly { id: string; name: string }[]>([]);
  const candidates = $derived(members.filter((member) => member.id !== requesterId));
  let loading = $state(false);
  let loadFailed = $state(false);
  let choice = $state('');
  let submitError = $state<string | null>(null);
  let submitting = $state(false);

  let generation = 0;
  // 閉じたワークスペースか、終わった、権限を失った、消えたエピックだと分かったら、ダイアログを閉じたときに画面を読み直す
  // （すぐに読み直すと、ダイアログごと外れて理由の文を読めなくなるため）
  let reloadOnClose: 'workspace' | 'epic' | null = null;
  $effect(() => {
    if (open || reloadOnClose === null) return;
    const target = reloadOnClose;
    reloadOnClose = null;
    if (target === 'workspace') void invalidateAll();
    else onchanged();
  });

  // ワークスペースかエピックが替わったら、開いたままにしない
  const currentKey = $derived(`${workspaceId}/${epicId}`);
  $effect(() => {
    void currentKey;
    return () => {
      generation++;
      submitting = false;
      open = false;
    };
  });

  export function show(trigger?: HTMLElement | null): void {
    generation++;
    reloadOnClose = null;
    members = [];
    loadFailed = false;
    choice = '';
    submitError = null;
    submitting = false;
    dialog?.show(trigger);
    void loadAndFocus(generation);
  }

  // 開いた直後は候補を読む前で選択欄が押せない（disabled）ので、フォーカスはダイアログの別の場所に入る。
  // 読めて候補があれば、まだ何も操作していない（フォーカスが選択欄の外の、押す要素でない所にある）ときだけ選択欄へ移す
  async function loadAndFocus(mine: number): Promise<void> {
    await loadMembers(mine);
    if (mine !== generation || candidates.length === 0) return;
    await tick();
    const active = document.activeElement;
    const untouched =
      active === null ||
      active === document.body ||
      active.tagName === 'DIALOG' ||
      active.closest('[data-close-dialog]');
    if (untouched || active === submitButton) select?.focus();
  }

  // 候補を読む。開き直した後と部品が外れた後の応答は捨てる。選んでいた人が候補から消えたら、最初の候補を選び直す
  async function loadMembers(mine: number): Promise<void> {
    loading = true;
    const result = await callOperation(memberList, { workspace_id: workspaceId }, { slug });
    if (mine !== generation) return;
    loading = false;
    if (!result.ok) {
      loadFailed = true;
      return;
    }
    loadFailed = false;
    members = result.data.members.map((member) => ({ id: member.id, name: member.name }));
    if (!candidates.some((candidate) => candidate.id === choice)) choice = candidates[0]?.id ?? '';
  }

  async function retry(): Promise<void> {
    if (loading) return;
    const mine = generation;
    await loadMembers(mine);
    if (mine !== generation || loadFailed) return;
    await tick();
    select?.focus();
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting || loading || choice === '') return;
    const mine = generation;
    const chosen = candidates.find((candidate) => candidate.id === choice);
    if (chosen === undefined) return;
    submitting = true;
    submitError = null;
    submitButton?.focus();
    let focusSelect = false;
    const words = {
      party: t('party'),
      epic: t('epic'),
      workspace: t('workspace'),
      requester: t('requester'),
      leader: t('leader'),
      name: chosen.name,
    };
    try {
      const result = await callOperation(
        epicRequesterUpdate,
        { workspace_id: workspaceId, epic_id: epicId, user_id: chosen.id },
        { slug },
      );
      if (mine !== generation) return;
      if (result.ok) {
        // 前の失敗で閉じたときの読み直しを残していれば外す（onchanged を二重に呼ばない）
        reloadOnClose = null;
        open = false;
        showToast(t(result.data.changed ? 'epicRequesterChanged' : 'epicRequesterAlready', words), 'check');
        onchanged();
        return;
      }
      if (result.status === 401) {
        // セッションが切れた。枠の読み直しがログインの画面へ移す
        await invalidateAll();
        return;
      }
      if (result.error?.code === 'workspace_closed') {
        submitError = t('workspaceClosedReadOnly', words);
        reloadOnClose = 'workspace';
      } else if (result.status === 409) {
        submitError = t('epicRequesterFinished', words);
        reloadOnClose = 'epic';
      } else if (result.status === 403) {
        submitError = t('epicRequesterForbidden', words);
        reloadOnClose = 'epic';
      } else if (result.status === 404) {
        // 選んだ人が所属を外れたか、エピックが消えた。候補を読み直して選び直してもらう
        submitError = t('epicRequesterGone', words);
        reloadOnClose = 'epic';
        await loadMembers(mine);
        focusSelect = true;
      } else {
        submitError = t('epicRequesterFailed', words);
      }
    } finally {
      if (mine === generation) {
        submitting = false;
        if (focusSelect) {
          await tick();
          select?.focus();
        }
      }
    }
  }

  // 欄の説明。読み直している間（もう一度試すを押した後も）は読み込み中の文を出す
  const hint = $derived(
    loading
      ? t('loading')
      : loadFailed
        ? t('epicRequesterCandidatesFailed')
        : candidates.length === 0
          ? t('epicRequesterNoCandidates', { workspace: t('workspace'), requester: t('requester') })
          : t('epicRequesterHint', { workspace: t('workspace'), party: t('party') }),
  );
  // 常に置いた読み上げの領域の文字。送っている間、読んでいる間、読めなかったとき、候補が無いときだけ入れる
  // （docs/design.md の「読み上げの領域は常に置き、文字だけを替える」）
  const status = $derived(
    submitting ? t('epicRequesterSubmitting') : loading || loadFailed || candidates.length === 0 ? hint : '',
  );
</script>

<Dialog
  bind:this={dialog}
  bind:open
  dismissible={!submitting}
  title={t('epicPageChangeRequester', { requester: t('requester') })}
>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    <fieldset class="form-fields" disabled={submitting}>
      <div class="field">
        <label class="field-label" for={selectId}>{t('epicRequesterField', { requester: t('requester') })}</label>
        <select
          class="select"
          id={selectId}
          bind:this={select}
          bind:value={choice}
          aria-busy={loading}
          aria-describedby={hintId}
          disabled={candidates.length === 0}
        >
          {#each candidates as candidate (candidate.id)}
            <option value={candidate.id}>{candidate.name}</option>
          {/each}
        </select>
        <!-- 欄の説明。読み上げには、下の常に置いた role="status" の領域で同じ文を伝える -->
        <span class="field-hint" id={hintId}>{hint}</span>
        {#if loadFailed}
          <div class="form-actions">
            <button class="btn is-sm is-quiet" type="button" aria-disabled={loading} onclick={() => void retry()}>
              {loading ? t('retrying') : t('retry')}
            </button>
          </div>
        {/if}
      </div>
    </fieldset>

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
      aria-disabled={submitting || loading || candidates.length === 0}
      bind:this={submitButton}
    >
      {submitting ? t('epicRequesterSubmitting') : t('epicRequesterSubmit')}
    </button>
  {/snippet}
</Dialog>
