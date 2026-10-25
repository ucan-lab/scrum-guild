<script lang="ts">
  import { tick } from 'svelte';
  import { beforeNavigate, goto, invalidateAll } from '$app/navigation';
  import { taskDelete, taskDetail, taskUpdate, type TaskDetail } from '../../shared/operations/task/index.ts';
  import {
    LINK_URL_MAX_LENGTH,
    STORY_TEXT_MAX_LENGTH,
    canonicalLinkUrl,
    linkUrlProblem,
    longTextProblem,
    normalizeLinkUrl,
    normalizeLongText,
  } from '../../shared/story.ts';
  import { TASK_POINT_VALUES, TASK_TITLE_MAX_LENGTH, taskTitleProblem } from '../../shared/task.ts';
  import { callOperation } from '../api.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import Drawer from './Drawer.svelte';
  import Icon from './Icon.svelte';
  import InlineEdit from './InlineEdit.svelte';
  import Markdown from './Markdown.svelte';

  // タスクの詳細の引き出しの中身（kit.js の drawerHtml）。`?task=<ID>` が付いている間、画面の枠（/[slug]/w/[id] のレイアウト）が置く。
  // 開いたら task-detail で1件を読む（本文は長いので、木には載せない）。読んでいる間は読み込み中を出し、読めなければ
  // （404 以外）もう一度試すを出す。404 は、トーストで知らせて閉じ、画面が木を読み直す（onremoved）。
  // 欄ごとに、その場で直す。ポイントと期日は選んだら保存し、タイトル、リンク、本文は InlineEdit で確定する（本文は Markdown の部品で描く）。
  // 送る欄は、今の値と違うものだけ。保存したら、その欄だけを応答で入れ替え、画面が木を読み直す（onchanged）。
  // 完了したタスクのポイントは直せない（欄を読み取り専用にして理由を添える）。取り込んだタスクのタイトルとリンクも直せない。
  // 閉じたワークスペース（canWrite が偽）では、直す口と削除を出さず、読み取り専用で開く。
  // 書きかけ（タイトル、リンク、本文の直している途中で、値が保存した値と違うもの）があるまま閉じる（×、幕、Esc）か、別のタスクや別の画面へ移る
  // （beforeNavigate）ときは、捨てるかをアプリの中のダイアログで確かめる。捨てると決めたら、閉じる／移る。
  // 削除は確認のダイアログを挟む。消したら閉じ、トーストで知らせ、画面が木を読み直す（onremoved）
  let {
    slug,
    workspaceId,
    taskId,
    canWrite,
    onclose,
    onchanged,
    onremoved,
  }: {
    slug: string;
    workspaceId: string;
    taskId: string;
    canWrite: boolean;
    // 閉じる。画面の枠が `?task=` を外し、フォーカスを行へ戻す
    onclose: () => void;
    // 欄を保存した。画面が木を読み直す
    onchanged: () => void;
    // タスクが消えた（削除した、見つからない）。画面が閉じて、木を読み直す
    onremoved: () => void;
  } = $props();

  const ids = $props.id();
  const titleLabelId = `${ids}-title`;
  const pointsLabelId = `${ids}-points`;
  const dueId = `${ids}-due`;
  const dueErrorId = `${ids}-due-error`;
  const pointsErrorId = `${ids}-points-error`;

  type PointsChoice = (typeof TASK_POINT_VALUES)[number] | null;
  // 先頭が「未」（未見積もり）
  const pointChoices: readonly PointsChoice[] = [null, ...TASK_POINT_VALUES];

  let loadState = $state<'loading' | 'ready' | 'failed'>('loading');
  let task = $state<TaskDetail | null>(null);
  let heading = $state<HTMLElement>();
  let discardDialog = $state<ReturnType<typeof ConfirmDialog>>();
  let deleteDialog = $state<ReturnType<typeof ConfirmDialog>>();

  // 直している途中の欄ごとの書きかけ
  const dirty = $state({ title: false, link: false, body: false });
  const hasDraft = $derived(dirty.title || dirty.link || dirty.body);

  // 選んだポイント。保存した値に追従し、選んだ直後は保存の結果が来るまで選んだ値を見せる
  let pointsChoice = $derived<PointsChoice>(task?.points ?? null);
  let pointsError = $state<string | null>(null);
  let dueError = $state<string | null>(null);
  let dueInput = $state<HTMLInputElement>();
  let deleting = $state(false);
  let deleteError = $state<string | null>(null);
  let loadVersion = 0;
  let pointsVersion = 0;
  let dueVersion = 0;

  // 部品が外れた後の応答で、状態を触らない
  let alive = true;
  $effect(() => () => {
    alive = false;
  });

  // 捨てると決めた後、閉じる／移るために確認を飛ばす
  let leaving = false;
  let asking = false;

  const pointsEditable = $derived(canWrite && task !== null && task.completed_at === null);
  const titleEditable = $derived(canWrite && task !== null && !task.is_imported);
  const done = $derived(task?.completed_at != null);

  async function load(): Promise<void> {
    const mine = ++loadVersion;
    loadState = 'loading';
    const result = await callOperation(taskDetail, { workspace_id: workspaceId, task_id: taskId }, { slug });
    if (!alive || mine !== loadVersion) return;
    if (result.ok) {
      task = result.data.task;
      loadState = 'ready';
      // 開いたときの読み上げに、見出しが読まれるようにする。閉じるボタンか何も無い所にフォーカスがあるときだけ移す
      await tick();
      if (!alive) return;
      const active = document.activeElement;
      if (active === document.body || active?.classList.contains('drawer-close')) heading?.focus();
      return;
    }
    if (result.status === 401) {
      await invalidateAll();
      return;
    }
    // 400 は、URL の `?task=` が ID の形でないとき。見つからないのと同じに扱う
    if (result.status === 404 || result.status === 400) {
      gone();
      return;
    }
    loadState = 'failed';
  }

  void load();

  // タスクが消えていた（別の人が削除した）。閉じて、木を読み直す
  function gone(): void {
    leaving = true;
    showToast(t('taskGone', { task: t('task') }), 'alert');
    onremoved();
  }

  // 閉じる操作。書きかけがあれば、捨てるかを確かめる
  async function requestClose(): Promise<void> {
    if (asking || leaving) return;
    if (hasDraft && !(await confirmDiscard())) return;
    leaving = true;
    onclose();
  }

  async function confirmDiscard(): Promise<boolean> {
    asking = true;
    try {
      return (await discardDialog?.ask()) ?? false;
    } finally {
      asking = false;
    }
  }

  // 別のタスクや別の画面へ移るとき（戻る／進む、行のリンク、左のメニュー）も、書きかけがあれば確かめる。
  // 同じタスクのままの移動と、閉じると決めた後は通す。ページを離れる（タブを閉じる、外のサイト）ときは、cancel() がブラウザの確認を出す
  beforeNavigate((navigation) => {
    if (leaving || !hasDraft || navigation.to === null) {
      if (!leaving && hasDraft && navigation.to === null) navigation.cancel();
      return;
    }
    const to = navigation.to.url;
    if (to.origin === location.origin && to.pathname === location.pathname && to.searchParams.get('task') === taskId) {
      return;
    }
    navigation.cancel();
    if (asking) return;
    void confirmDiscard().then((discard) => {
      if (!discard) return;
      leaving = true;
      // 同じ画面の中で別のタスクへ移るときは、スクロールとフォーカスを動かさない
      if (to.origin !== location.origin) location.href = to.href;
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- 行き先は SvelteKit が解決した URL（navigation.to）で、経路から作り直せない
      else void goto(to, { reset: to.pathname !== location.pathname });
    });
  });

  // 保存に使う応答の扱い。送った欄だけを応答で入れ替える（別の欄の保存と前後しても、古い値で戻さない）
  type Fields = Partial<Pick<TaskDetail, 'title' | 'points' | 'due_on' | 'link_url' | 'body_md'>>;

  // 欄を書く。成功なら null、失敗ならエラーの文。404 は閉じる側へ回す（文は返さない）
  async function saveFields(fields: Fields): Promise<string | null> {
    const result = await callOperation(taskUpdate, { workspace_id: workspaceId, task_id: taskId, ...fields }, { slug });
    if (!alive) return null;
    if (result.ok) {
      if (task !== null) {
        const saved = result.data.task;
        const merged: TaskDetail = { ...task, completed_at: saved.completed_at, can_delete: saved.can_delete };
        for (const key of Object.keys(fields) as (keyof Fields)[]) Object.assign(merged, { [key]: saved[key] });
        task = merged;
      }
      showToast(t('taskSaved'), 'check');
      onchanged();
      return null;
    }
    if (result.status === 401) {
      await invalidateAll();
      return t('taskSaveFailed');
    }
    if (result.status === 404) {
      gone();
      return null;
    }
    if (result.status === 409 && result.error?.code === 'workspace_closed') {
      // 閉じた。枠を読み直して、読み取り専用の表示に切り替える
      onchanged();
      return t('workspaceClosedReadOnly', { workspace: t('workspace') });
    }
    if (result.status === 409) {
      // 完了にされていた（ポイント）。読み直して、直せない表示にする
      void refresh();
      return t('taskSaveConflict', { task: t('task'), done: t('done'), points: t('points') });
    }
    if (result.status === 400) return t('taskBadRequest');
    return t('taskSaveFailed');
  }

  // 保存に負けたときに、今の値を読み直す。読めなければ今の表示のまま
  async function refresh(): Promise<void> {
    const result = await callOperation(taskDetail, { workspace_id: workspaceId, task_id: taskId }, { slug });
    if (alive && result.ok) task = result.data.task;
  }

  // ---- タイトル、リンク、本文（InlineEdit） ----
  function titleProblem(raw: string): string | null {
    const problem = taskTitleProblem(raw.trim());
    if (problem === 'required') return t('taskTitleRequired');
    if (problem === 'too_long') return t('taskTitleTooLong', { max: TASK_TITLE_MAX_LENGTH });
    if (problem === 'invalid_character') return t('taskTitleInvalidCharacter');
    return null;
  }

  function saveTitle(raw: string): Promise<string | null> {
    const next = raw.trim();
    return task === null || next === task.title ? Promise.resolve(null) : saveFields({ title: next });
  }

  function linkProblemMessage(raw: string): string | null {
    const value = normalizeLinkUrl(raw);
    const problem = value === null ? null : linkUrlProblem(value);
    if (problem === 'too_long') return t('linkTooLong', { max: LINK_URL_MAX_LENGTH });
    if (problem === 'invalid_url') return t('linkInvalid');
    return null;
  }

  function saveLink(raw: string): Promise<string | null> {
    const value = normalizeLinkUrl(raw);
    const next = value === null ? null : canonicalLinkUrl(value);
    return task === null || next === task.link_url ? Promise.resolve(null) : saveFields({ link_url: value });
  }

  function bodyProblem(raw: string): string | null {
    const value = normalizeLongText(raw);
    const problem = value === null ? null : longTextProblem(value);
    if (problem === 'too_long') return t('fieldTextTooLong', { field: t('fieldBody'), max: STORY_TEXT_MAX_LENGTH });
    if (problem === 'invalid_character') return t('fieldTextInvalidCharacter', { field: t('fieldBody') });
    return null;
  }

  function saveBody(raw: string): Promise<string | null> {
    const next = normalizeLongText(raw);
    return task === null || next === task.body_md ? Promise.resolve(null) : saveFields({ body_md: next });
  }

  // ---- ポイントと期日（選んだら保存する） ----
  async function savePoints(choice: PointsChoice): Promise<void> {
    if (task === null || choice === task.points) return;
    const mine = ++pointsVersion;
    pointsError = null;
    const message = await saveFields({ points: choice });
    if (!alive || mine !== pointsVersion || message === null) return;
    pointsError = message;
    pointsChoice = task?.points ?? null;
  }

  async function saveDue(): Promise<void> {
    if (task === null || dueInput === undefined) return;
    // 途中までしか打たれていない値や存在しない日付は、value が空になり、validity.badInput が立つ
    if (dueInput.validity.badInput) {
      dueError = t('dueInvalid', { due: t('due') });
      return;
    }
    const next = dueInput.value === '' ? null : dueInput.value;
    if (next === task.due_on) return;
    const mine = ++dueVersion;
    dueError = null;
    const message = await saveFields({ due_on: next });
    if (!alive || mine !== dueVersion || message === null) return;
    dueError = message;
    if (dueInput) dueInput.value = task?.due_on ?? '';
  }

  function clearDue(): void {
    if (dueInput === undefined) return;
    dueInput.value = '';
    void saveDue();
  }

  // ---- 削除 ----
  async function remove(event: MouseEvent): Promise<void> {
    if (task === null || deleting || asking) return;
    const trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    asking = true;
    let confirmed: boolean;
    try {
      confirmed = (await deleteDialog?.ask(trigger)) ?? false;
    } finally {
      asking = false;
    }
    if (!confirmed || !alive) return;
    deleting = true;
    deleteError = null;
    try {
      const result = await callOperation(taskDelete, { workspace_id: workspaceId, task_id: taskId }, { slug });
      if (!alive) return;
      if (result.ok) {
        // 消えたので、書きかけがあっても確かめずに閉じる
        leaving = true;
        showToast(t('taskDeleted', { task: t('task') }), 'check');
        onremoved();
      } else if (result.status === 401) {
        await invalidateAll();
      } else if (result.status === 404) {
        gone();
      } else if (result.status === 403) {
        deleteError = t('taskDeleteForbidden', { leader: t('leader') });
      } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
        deleteError = t('workspaceClosedReadOnly', { workspace: t('workspace') });
        onchanged();
      } else {
        deleteError = t('taskDeleteFailed');
      }
    } finally {
      if (alive) deleting = false;
    }
  }

  const status = $derived(loadState === 'loading' ? t('loading') : deleting ? t('taskDeleting') : '');
</script>

{#snippet titleView(begin: ((event: Event) => void) | null)}
  <!-- tabindex="-1" は、開いたときに見出しへフォーカスを置くため（キーボードの Tab 順には入らない） -->
  <h2 class="drawer-title" tabindex="-1" bind:this={heading}>
    {#if begin !== null}
      <button class="edit-trigger" type="button" onclick={begin}>
        <span id={titleLabelId}>{task?.title}</span>
        <Icon name="pen" />
        <span class="visually-hidden">{t('taskTitleEditHint', { task: t('task') })}</span>
      </button>
    {:else}
      <span id={titleLabelId}>{task?.title}</span>
    {/if}
  </h2>
{/snippet}

<Drawer labelledBy={titleLabelId} busy={loadState === 'loading'} onrequestclose={() => void requestClose()}>
  {#snippet top()}
    {#if task !== null}
      <span class="chip"
        ><Icon name={task.is_imported ? 'link' : 'pen'} />{task.is_imported
          ? t('taskImportedChip', { task: t('task') })
          : t('taskManualChip', { task: t('task') })}</span
      >
      {#if done}<span class="chip is-ok"><Icon name="check" />{t('done')}</span>{/if}
    {/if}
  {/snippet}

  {#if loadState === 'loading'}
    <!-- 読み上げは下の role="status" が伝えるので、見える文字だけにする -->
    <h2 class="drawer-title" tabindex="-1" bind:this={heading}><span id={titleLabelId}>{t('task')}</span></h2>
    <p class="field-hint" aria-hidden="true">{t('loading')}</p>
  {:else if loadState === 'failed'}
    <h2 class="drawer-title" tabindex="-1" bind:this={heading}><span id={titleLabelId}>{t('task')}</span></h2>
    <div class="callout is-danger" role="alert">
      <Icon name="alert" /><span>{t('taskDrawerLoadFailed', { task: t('task') })}</span>
    </div>
    <div class="form-actions">
      <button class="btn" type="button" onclick={() => void load()}>{t('retry')}</button>
    </div>
  {:else if task !== null}
    {#if !canWrite}
      <div class="callout is-info">
        <Icon name="shield" /><span>{t('taskReadOnly', { workspace: t('workspace'), task: t('task') })}</span>
      </div>
    {/if}

    {#if titleEditable}
      <InlineEdit
        value={task.title}
        label={t('fieldTitle')}
        labelHidden
        placeholder={t('taskTitlePlaceholder')}
        problem={titleProblem}
        save={saveTitle}
        ondirty={(value) => (dirty.title = value)}
      >
        {#snippet view(begin)}{@render titleView(begin)}{/snippet}
      </InlineEdit>
    {:else}
      {@render titleView(null)}
    {/if}

    <dl class="props">
      <div>
        <dt id={pointsLabelId}>{t('points')}</dt>
        <dd>
          <div
            class="segmented"
            role="radiogroup"
            aria-labelledby={pointsLabelId}
            aria-describedby={pointsError !== null ? pointsErrorId : undefined}
          >
            {#each pointChoices as choice (choice)}
              <label>
                <input
                  type="radio"
                  name="{ids}-points"
                  value={choice}
                  checked={pointsChoice === choice}
                  disabled={!pointsEditable}
                  onchange={() => {
                    pointsChoice = choice;
                    void savePoints(choice);
                  }}
                  aria-label={choice === null ? t('pointsUnsetTitle') : undefined}
                />
                <span>{choice === null ? t('pointsUnsetMark') : choice}</span>
              </label>
            {/each}
          </div>
          {#if done}<span class="props-note">{t('taskPointsLocked', { done: t('done') })}</span>{/if}
          {#if pointsError !== null}
            <span class="field-error" id={pointsErrorId} role="alert"><Icon name="alert" />{pointsError}</span>
          {/if}
        </dd>
      </div>
      <div>
        <dt><label for={dueId}>{t('due')}</label></dt>
        <dd>
          {#if canWrite}
            <input
              class="input"
              id={dueId}
              type="date"
              bind:this={dueInput}
              value={task.due_on ?? ''}
              onchange={() => void saveDue()}
              aria-invalid={dueError !== null}
              aria-describedby={dueError !== null ? dueErrorId : undefined}
            />
            {#if task.due_on !== null}
              <button class="link-btn" type="button" onclick={clearDue}>{t('dueClear')}</button>
            {/if}
          {:else}
            <!-- 日付の入力は readonly を受けないので、読み取り専用では文字で出す -->
            <input class="input" id={dueId} type="text" value={task.due_on ?? ''} readonly />
          {/if}
          {#if dueError !== null}
            <span class="field-error" id={dueErrorId} role="alert"><Icon name="alert" />{dueError}</span>
          {/if}
        </dd>
      </div>
      {#if !task.is_imported}
        <div>
          <dt>{t('fieldLink')}</dt>
          <dd>
            {#if canWrite}
              <InlineEdit
                value={task.link_url ?? ''}
                label={t('fieldLink')}
                labelHidden
                inputType="url"
                placeholder={t('linkPlaceholder')}
                problem={linkProblemMessage}
                save={saveLink}
                ondirty={(value) => (dirty.link = value)}
              >
                {#snippet view(begin)}
                  <button class="edit-trigger" class:is-empty={task?.link_url === null} type="button" onclick={begin}>
                    {#if task?.link_url != null}
                      <span class="source-key"><Icon name="link" /> {task.link_url}</span>
                    {:else}
                      <span>{t('linkAdd')}</span>
                    {/if}
                    <Icon name="pen" />
                    <span class="visually-hidden">{t('linkEditHint')}</span>
                  </button>
                {/snippet}
              </InlineEdit>
            {:else if task.link_url !== null}
              <span class="source-key"><Icon name="link" /> {task.link_url}</span>
            {:else}
              —
            {/if}
            {#if task.link_url !== null}
              <!-- 外のサイトは新しいタブで開く。読み上げにも、新しいタブで開くことを含める -->
              <a
                class="btn is-sm"
                href={task.link_url}
                target="_blank"
                rel="external noopener noreferrer"
                aria-label={t('storyLinkOpenLabel')}>{t('storyLinkOpen')}</a
              >
            {/if}
          </dd>
        </div>
      {/if}
    </dl>

    <div class="field">
      {#if canWrite}
        <InlineEdit
          value={task.body_md ?? ''}
          label={t('fieldBody')}
          multiline
          hint={t('bodyEditHint')}
          problem={bodyProblem}
          save={saveBody}
          ondirty={(value) => (dirty.body = value)}
        >
          {#snippet view(begin)}
            <div class="field-head">
              <span class="field-label">{t('fieldBody')}</span>
              <button class="btn is-sm" type="button" onclick={begin}><Icon name="pen" />{t('editBody')}</button>
            </div>
            {@render bodyView()}
          {/snippet}
        </InlineEdit>
      {:else}
        <span class="field-label">{t('fieldBody')}</span>
        {@render bodyView()}
      {/if}
    </div>

    {#if canWrite}
      <div class="form-actions">
        {#if task.can_delete}
          <button
            class="btn is-sm is-quiet is-danger"
            type="button"
            aria-disabled={deleting}
            onclick={(event) => void remove(event)}
          >
            <Icon name="trash" />{t('taskDelete', { task: t('task') })}
          </button>
        {/if}
        <span class="field-hint">{t('taskDeleteWho', { leader: t('leader') })}</span>
      </div>
      {#if deleteError !== null}
        <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{deleteError}</span></div>
      {/if}
    {/if}
  {/if}

  <!-- 状態の読み上げの領域。常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{status}</span>
</Drawer>

{#snippet bodyView()}
  {#if task?.body_md != null}
    <Markdown source={task.body_md} headingStart={3} />
  {:else}
    <div class="doc-box is-empty">{t('bodyEmpty')}</div>
  {/if}
{/snippet}

<ConfirmDialog
  bind:this={discardDialog}
  title={t('discardTitle')}
  confirmLabel={t('discardConfirm')}
  cancelLabel={t('discardKeep')}
  danger
>
  <p>{t('discardText')}</p>
</ConfirmDialog>

<ConfirmDialog
  bind:this={deleteDialog}
  title={t('taskDeleteTitle', { task: t('task') })}
  confirmLabel={t('taskDeleteConfirm')}
  cancelLabel={t('taskDeleteCancel')}
  danger
>
  <p>{t('taskDeleteText', { title: task?.title ?? '' })}</p>
  <p class="field-hint">{t('taskDeleteHint')}</p>
</ConfirmDialog>
