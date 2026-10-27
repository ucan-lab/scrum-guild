<script lang="ts">
  import { tick } from 'svelte';
  import { COMMENT_BODY_MAX_LENGTH, commentBodyProblem } from '../../shared/comment.ts';
  import { conflictReasonOf } from '../../shared/operations/conflict-reason.ts';
  import {
    commentConflictReasons,
    commentCreate,
    commentDelete,
    commentList,
    commentUpdate,
    type Comment,
    type CommentCursor,
  } from '../../shared/operations/task/index.ts';
  import { normalizeLongText } from '../../shared/story.ts';
  import { callOperation } from '../api.ts';
  import { reloadView } from '../comment-thread.ts';
  import { formatHistoryTime } from '../task-history.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Avatar from './Avatar.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import Icon from './Icon.svelte';
  import Markdown from './Markdown.svelte';

  // 詳細の引き出しの「コメント」のタブの中身（kit.js の drawerHtml の .thread と commentHtml）。
  // 開いたら comment-list で新しい 50 件を読み、書いた順に並べる。それより前は、一覧の上の「前のコメントを読む」で足す。
  // 1件は、アバター、名前、日時（ワークスペースのタイムゾーン）、「編集済み」と、右に許された操作（can_edit、can_delete）だけの
  // 「編集」「削除」（.btn.is-sm.is-quiet）。本文は Markdown の部品で描く。消したものは「削除されました」、本人以外が消したら「〇〇が削除しました」。
  // 「編集」は本文がその場で書く欄に替わり（直す前の本文が入る）、「保存」か「取り消し」で戻る。「削除」は確かめのダイアログ（danger）を挟む。
  // 下に新しいコメントの欄と「送る」。送るのは1本ずつで、失敗したら文を欄に残して理由を欄の下に出し、通ったら欄を空にして末尾に足し、そこまで送る。
  // 書きかけ（hasDraft）は、新しいコメントの欄に文字があるときと、直している途中で直す前の本文と違うとき。送っている間も数える。
  // 直している間に別の人（リーダー）がそのコメントを消すと、保存は 409（deleted）で断られる。書きかけは欄に残して知らせ、一覧を読み直す。
  // 閉じたワークスペース（canWrite が偽）では、書く欄と操作を出さない。
  // タスクが消えた（404）ときは ongone、未ログインと閉じたと分かったときは onstale で引き出しに伝える。件数は oncount で渡す
  let {
    slug,
    workspaceId,
    taskId,
    canWrite,
    oncount,
    ongone,
    onstale,
  }: {
    slug: string;
    workspaceId: string;
    taskId: string;
    canWrite: boolean;
    // 消していないコメントの数（タブの「コメント N」）
    oncount: (count: number) => void;
    ongone: () => void;
    onstale: () => void;
  } = $props();

  const ids = $props.id();
  const newId = `${ids}-new`;
  const newHintId = `${ids}-new-hint`;
  const newErrorId = `${ids}-new-error`;

  type EditState = {
    draft: string;
    // 直し始めたときの本文。書きかけの判定に使う
    original: string;
    error: string | null;
    saving: boolean;
    // 保存できなくなった（消された、権限が無い）。書きかけは欄に残し、「保存」を出さない
    blocked: boolean;
  };

  let loadState = $state<'loading' | 'ready' | 'failed'>('loading');
  let comments = $state.raw<readonly Comment[]>([]);
  let next = $state<CommentCursor | null>(null);
  let timezone = $state('UTC');
  let reloading = $state(false);
  let reloadFailed = $state(false);
  let older = $state<'idle' | 'loading' | 'failed'>('idle');
  let version = 0;
  // 消していないコメントの数。一覧を読めた値から始め、書いたら足し、消したら引く（読み込んでいない前のコメントも数えるので、
  // 一覧からは数えない）。一覧を読めるまでは書く欄を出さないので、読めた値より前には動かない
  let count = 0;
  // 書いた行と、その順番。読み直しは、始めた後に書いた行だけを応答に重ねる
  let writes: { seq: number; comment: Comment }[] = [];
  let writeSeq = 0;
  function setCount(value: number): void {
    count = Math.max(0, value);
    oncount(count);
  }
  // 読み上げに伝える文（読み込み、足した件数、送った、直した、削除した）
  let announce = $state('');

  let newDraft = $state('');
  let newError = $state<string | null>(null);
  let sending = $state(false);
  let newInput = $state<HTMLTextAreaElement>();
  const edits: Record<string, EditState> = $state({});
  // 削除を送っているコメント。送っている間は、どの行の「削除」も押せなくする
  let deleting = $state<string | null>(null);
  // 消すかを確かめているコメント（確かめの文に、書いた人と日時を添える）
  let deleteTarget = $state<Comment | null>(null);
  let deleteDialog = $state<ReturnType<typeof ConfirmDialog>>();
  let container = $state<HTMLElement>();

  let alive = true;
  $effect(() => () => {
    alive = false;
  });

  // 整えた後の本文。空は空の文字
  const normalized = (raw: string) => normalizeLongText(raw) ?? '';

  // 引き出しの書きかけ。送っている間と保存している間も数える（失敗したときに文が消えないよう、閉じる前に確かめる）
  export function hasDraft(): boolean {
    if (sending || normalized(newDraft) !== '') return true;
    return Object.values(edits).some((edit) => edit.saving || normalized(edit.draft) !== normalized(edit.original));
  }

  function problemMessage(raw: string): string | null {
    const problem = commentBodyProblem(raw);
    if (problem === 'required') return t('commentRequired');
    if (problem === 'too_long')
      return t('fieldTextTooLong', { field: t('commentField'), max: COMMENT_BODY_MAX_LENGTH });
    if (problem === 'invalid_character') return t('fieldTextInvalidCharacter', { field: t('commentField') });
    return null;
  }

  // 新しい 50 件を読み直す。読み直している間は前に読めた行を残す。直している途中のコメントが消されていたら、書きかけを残して知らせる
  async function load(focusAfter = false): Promise<void> {
    const mine = ++version;
    const startSeq = writeSeq;
    reloading = true;
    older = 'idle';
    const result = await callOperation(commentList, { workspace_id: workspaceId, task_id: taskId }, { slug });
    if (!alive || mine !== version) return;
    reloading = false;
    if (result.ok) {
      // 前に足した古い行は地続きのときだけ残し、読み直しを始めた後に書いた行を重ねる（src/lib/comment-thread.ts）
      const view = reloadView(
        { comments, next, count },
        result.data,
        writes.filter((write) => write.seq > startSeq).map((write) => write.comment),
      );
      // 次の読み直しは、これより後に始まるので、この読み直しより前の書き込みは要らない
      writes = writes.filter((write) => write.seq > startSeq);
      comments = view.comments;
      next = view.next;
      timezone = result.data.timezone;
      loadState = 'ready';
      reloadFailed = false;
      setCount(view.count);
      for (const comment of comments) {
        const edit = edits[comment.id];
        if (edit !== undefined && comment.deleted_at !== null && !edit.blocked) {
          edit.blocked = true;
          edit.error = t('commentGoneWhileEditing');
        }
      }
      if (focusAfter) {
        await tick();
        if (alive) container?.focus();
      }
      return;
    }
    if (result.status === 404) {
      ongone();
      return;
    }
    if (result.status === 401) onstale();
    if (loadState === 'ready') reloadFailed = true;
    else loadState = 'failed';
  }

  void load();

  function retry(): void {
    if (reloading) return;
    void load(true);
  }

  // 前の 50 件を一覧の上に足す。先頭を読み直したら、古い応答は捨てる。読み終えてボタンが消えたら、一覧へフォーカスを移す
  async function loadOlder(): Promise<void> {
    const before = next;
    if (before === null || older === 'loading' || reloading) return;
    const mine = version;
    older = 'loading';
    announce = '';
    const result = await callOperation(commentList, { workspace_id: workspaceId, task_id: taskId, before }, { slug });
    if (!alive || mine !== version) return;
    if (!result.ok) {
      // 先頭の読み直しと同じく、タスクが消えた（404）なら引き出しに伝えて閉じ、未ログインは引き出しに伝える
      if (result.status === 404) {
        ongone();
        return;
      }
      if (result.status === 401) onstale();
      older = 'failed';
      return;
    }
    const known = new Set(comments.map((comment) => comment.id));
    comments = [...result.data.comments.filter((comment) => !known.has(comment.id)), ...comments];
    next = result.data.next;
    older = 'idle';
    announce = t('commentOlderAdded', { count: result.data.comments.length });
    if (next === null) {
      await tick();
      if (alive) container?.focus();
    }
  }

  // 書いた（作った、直した、消した）行を一覧に入れ、件数を動かす。書いた行は、それより前に始めた読み直しの古い応答で
  // 消えないよう、読み直しの結果にも重ねる（reloadView の writes）
  function record(comment: Comment): void {
    writes = [...writes, { seq: ++writeSeq, comment }];
    const before = comments.find((current) => current.id === comment.id);
    comments =
      before === undefined
        ? [...comments, comment]
        : comments.map((current) => (current.id === comment.id ? comment : current));
    if (before === undefined && comment.deleted_at === null) setCount(count + 1);
    else if (before !== undefined && before.deleted_at === null && comment.deleted_at !== null) setCount(count - 1);
  }

  // 書けなかった理由のうち、どの操作にも共通のもの。閉じた、未ログインは引き出しに伝える
  function commonFailure(status: number, code: string | undefined): string | null {
    if (status === 409 && code === 'workspace_closed') {
      onstale();
      return t('workspaceClosedReadOnly', { workspace: t('workspace') });
    }
    if (status === 401) {
      onstale();
      return t('taskSaveFailed');
    }
    return null;
  }

  // ---- 新しいコメント ----
  async function send(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (sending) return;
    newError = problemMessage(newDraft);
    if (newError !== null) {
      newInput?.focus();
      return;
    }
    sending = true;
    announce = t('commentSending');
    try {
      const result = await callOperation(
        commentCreate,
        { workspace_id: workspaceId, task_id: taskId, body_md: newDraft },
        { slug },
      );
      if (!alive) {
        if (result.ok) showToast(t('commentSent'), 'check');
        else showToast(t('commentSendFailed'), 'alert');
        return;
      }
      if (result.ok) {
        record(result.data.comment);
        newDraft = '';
        announce = t('commentSent');
        await tick();
        if (!alive) return;
        container?.querySelector(`[data-comment="${result.data.comment.id}"]`)?.scrollIntoView({ block: 'nearest' });
        newInput?.focus();
        return;
      }
      announce = '';
      if (result.status === 404) {
        ongone();
        return;
      }
      newError =
        commonFailure(result.status, result.error?.code) ??
        (result.status === 400 ? (problemMessage(newDraft) ?? t('taskBadRequest')) : t('commentSendFailed'));
      newInput?.focus();
    } finally {
      if (alive) sending = false;
    }
  }

  // ---- 直す ----
  async function startEdit(comment: Comment): Promise<void> {
    if (edits[comment.id] !== undefined) return;
    edits[comment.id] = {
      draft: comment.body_md,
      original: comment.body_md,
      error: null,
      saving: false,
      blocked: false,
    };
    await tick();
    const input = container?.querySelector<HTMLTextAreaElement>(`[data-comment-input="${comment.id}"]`);
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }

  async function finishEdit(id: string): Promise<void> {
    delete edits[id];
    await tick();
    if (!alive) return;
    const button = container?.querySelector<HTMLElement>(`[data-comment-edit="${id}"]`);
    if (button) button.focus();
    else container?.focus();
  }

  function cancelEdit(id: string): void {
    if (edits[id]?.saving) return;
    void finishEdit(id);
  }

  async function saveEdit(event: SubmitEvent, id: string): Promise<void> {
    event.preventDefault();
    const edit = edits[id];
    if (edit === undefined || edit.saving || edit.blocked) return;
    const input = container?.querySelector<HTMLTextAreaElement>(`[data-comment-input="${id}"]`);
    edit.error = problemMessage(edit.draft);
    if (edit.error !== null) {
      input?.focus();
      return;
    }
    // 直す前と同じなら送らずに戻す
    if (normalized(edit.draft) === normalized(edit.original)) {
      void finishEdit(id);
      return;
    }
    edit.saving = true;
    announce = t('commentSaving');
    try {
      const result = await callOperation(
        commentUpdate,
        { workspace_id: workspaceId, comment_id: id, body_md: edit.draft },
        { slug },
      );
      if (!alive) {
        if (result.ok) showToast(t('commentSaved'), 'check');
        else showToast(t('commentSaveFailed'), 'alert');
        return;
      }
      announce = '';
      if (result.ok) {
        record(result.data.comment);
        showToast(t('commentSaved'), 'check');
        edit.saving = false;
        await finishEdit(id);
        return;
      }
      const code = result.error?.code;
      if (result.status === 409 && conflictReasonOf(result.error?.details, commentConflictReasons) === 'deleted') {
        // 直している間に消された。書きかけは欄に残し、一覧を読み直す
        edit.blocked = true;
        edit.error = t('commentGoneWhileEditing');
        void load();
      } else if (result.status === 403) {
        edit.blocked = true;
        edit.error = t('commentForbidden');
        void load();
      } else if (result.status === 404) {
        // タスクが消えたかを、一覧を読み直して決める（消えていれば引き出しを閉じる）
        edit.error = t('commentSaveFailed');
        void load();
      } else {
        edit.error =
          commonFailure(result.status, code) ??
          (result.status === 400 ? (problemMessage(edit.draft) ?? t('taskBadRequest')) : t('commentSaveFailed'));
      }
      input?.focus();
    } finally {
      const current = edits[id];
      if (current !== undefined) current.saving = false;
    }
  }

  // ---- 消す ----
  async function remove(event: MouseEvent, comment: Comment): Promise<void> {
    if (deleting !== null) return;
    const trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    deleteTarget = comment;
    const confirmed = (await deleteDialog?.ask(trigger)) ?? false;
    if (!confirmed || !alive) return;
    deleting = comment.id;
    announce = t('commentDeleting');
    try {
      const result = await callOperation(
        commentDelete,
        { workspace_id: workspaceId, comment_id: comment.id },
        { slug },
      );
      if (!alive) {
        if (result.ok) showToast(t('commentRemoved'), 'check');
        else showToast(t('commentDeleteFailed'), 'alert');
        return;
      }
      announce = '';
      if (result.ok) {
        record(result.data.comment);
        delete edits[comment.id];
        showToast(t('commentRemoved'), 'check');
        // 押したボタンは消えるので、一覧へフォーカスを移す
        await tick();
        if (alive) container?.focus();
        return;
      }
      const code = result.error?.code;
      if (result.status === 409 && conflictReasonOf(result.error?.details, commentConflictReasons) === 'deleted') {
        showToast(t('commentAlreadyDeleted'), 'alert');
        void load();
      } else if (result.status === 403) {
        showToast(t('commentForbidden'), 'alert');
        void load();
      } else if (result.status === 404) {
        void load();
      } else {
        showToast(commonFailure(result.status, code) ?? t('commentDeleteFailed'), 'alert');
      }
    } finally {
      if (alive) deleting = null;
    }
  }

  function deletedText(comment: Comment): string {
    const by = comment.deleted_by;
    return by === null || by.id === comment.author.id
      ? t('commentDeleted')
      : t('commentDeletedBy', { name: by.name === '' ? t('historyUnknownName') : by.name });
  }

  const status = $derived(loadState === 'loading' || older === 'loading' ? t('loading') : announce);
</script>

<!-- tabindex="-1" は、前のコメントを読み終えたとき、もう一度試して読めたとき、コメントを消したときにフォーカスを置くため。
     フォーカスを置いたときに何の領域かが読まれるよう、名前を付ける -->
<div
  class="thread"
  role="region"
  aria-label={t('commentThread')}
  tabindex="-1"
  bind:this={container}
  aria-busy={loadState === 'loading' || reloading}
>
  <!-- 読み込みの進み具合と、足した件数、送った、直した、削除したことの読み上げの領域。常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{status}</span>
  {#if loadState === 'loading'}
    <p class="field-hint" aria-hidden="true">{t('loading')}</p>
  {:else if loadState === 'failed'}
    <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{t('commentLoadFailed')}</span></div>
    <div class="form-actions">
      <button class="btn is-sm" type="button" aria-disabled={reloading} onclick={retry}>
        {reloading ? t('retrying') : t('retry')}
      </button>
    </div>
  {:else}
    {#if reloadFailed}
      <div class="form-actions">
        <span class="field-error" role="alert"><Icon name="alert" />{t('commentReloadFailed')}</span>
        <button class="btn is-sm is-quiet" type="button" aria-disabled={reloading} onclick={retry}>
          {reloading ? t('retrying') : t('retry')}
        </button>
      </div>
    {/if}
    {#if next !== null}
      <div class="form-actions">
        <button
          class="btn is-sm"
          type="button"
          aria-disabled={older === 'loading' || reloading}
          onclick={() => void loadOlder()}
        >
          {older === 'loading' ? t('loading') : t('commentOlder')}
        </button>
      </div>
    {/if}
    {#if older === 'failed'}
      <span class="field-error" role="alert"><Icon name="alert" />{t('commentOlderFailed')}</span>
    {/if}
    {#each comments as comment (comment.id)}
      {@const edit = edits[comment.id]}
      {@const deleted = comment.deleted_at !== null}
      {@const headId = `${ids}-head-${comment.id}`}
      {@const inputId = `${ids}-edit-${comment.id}`}
      {@const errorId = `${ids}-edit-error-${comment.id}`}
      {@const showEdit = canWrite && comment.can_edit && edit === undefined}
      {@const showDelete = canWrite && comment.can_delete && edit === undefined}
      <div class="comment" class:is-deleted={deleted} data-comment={comment.id}>
        <Avatar userId={comment.author.id} name={comment.author.name} decorative />
        <div>
          <!-- 「編集」「削除」の説明（aria-describedby）は、どのコメントかが分かる名前と日時 -->
          <div class="comment-head">
            <b id="{headId}-name">{comment.author.name === '' ? t('historyUnknownName') : comment.author.name}</b>
            <time class="mono" id="{headId}-at" datetime={comment.created_at}
              >{formatHistoryTime(comment.created_at, timezone)}</time
            >
            {#if comment.edited_at !== null && !deleted}<span>{t('commentEdited')}</span>{/if}
            {#if showEdit || showDelete}
              <span class="comment-actions">
                {#if showEdit}
                  <button
                    class="btn is-sm is-quiet"
                    type="button"
                    data-comment-edit={comment.id}
                    aria-describedby="{headId}-name {headId}-at"
                    onclick={() => void startEdit(comment)}>{t('commentEdit')}</button
                  >
                {/if}
                {#if showDelete}
                  <button
                    class="btn is-sm is-quiet"
                    type="button"
                    aria-describedby="{headId}-name {headId}-at"
                    aria-disabled={deleting !== null}
                    onclick={(event) => void remove(event, comment)}>{t('commentDelete')}</button
                  >
                {/if}
              </span>
            {/if}
          </div>
          {#if edit !== undefined}
            <!-- 直している途中。消されたあとも、書きかけは欄に残す（「保存」は出さない） -->
            <form class="edit-form" onsubmit={(event) => void saveEdit(event, comment.id)} novalidate>
              <div class="field" class:is-invalid={edit.error !== null}>
                <label class="field-label visually-hidden" for={inputId}>{t('commentEditLabel')}</label>
                <textarea
                  class="textarea"
                  id={inputId}
                  data-comment-input={comment.id}
                  value={edit.draft}
                  oninput={(event) => {
                    edit.draft = event.currentTarget.value;
                    if (!edit.blocked) edit.error = null;
                  }}
                  readonly={edit.saving}
                  aria-invalid={edit.error !== null}
                  aria-describedby={edit.error !== null ? errorId : undefined}></textarea>
                {#if edit.error !== null}
                  <span class="field-error" id={errorId} role="alert"><Icon name="alert" />{edit.error}</span>
                {/if}
              </div>
              <div class="edit-actions">
                {#if !edit.blocked}
                  <button class="btn is-primary is-sm" type="submit" aria-disabled={edit.saving}>{t('editSave')}</button
                  >
                {/if}
                <button
                  class="btn is-sm is-quiet"
                  type="button"
                  aria-disabled={edit.saving}
                  onclick={() => cancelEdit(comment.id)}>{t('editCancel')}</button
                >
              </div>
            </form>
          {:else if deleted}
            <p class="comment-body">{deletedText(comment)}</p>
          {:else}
            <div class="comment-body"><Markdown source={comment.body_md} /></div>
          {/if}
        </div>
      </div>
    {:else}
      <p class="props-note">{t('commentEmpty')}</p>
    {/each}
  {/if}

  <!-- 新しいコメントの欄は、一覧を読めてから出す（読めるまでは件数も無く、送った行を並べる先も無い）。
       書き込めなくなった（閉じた）ときに書きかけがあれば、欄を読み取り専用で残して理由を添え、「送る」を出さない -->
  {#if loadState === 'ready' && (canWrite || normalized(newDraft) !== '')}
    <form class="edit-form" onsubmit={(event) => void send(event)} novalidate>
      <div class="field" class:is-invalid={newError !== null}>
        <label class="field-label" for={newId}>{t('commentNewLabel')}</label>
        <textarea
          class="textarea"
          id={newId}
          bind:this={newInput}
          bind:value={newDraft}
          oninput={() => (newError = null)}
          readonly={sending || !canWrite}
          placeholder={t('commentPlaceholder')}
          aria-invalid={newError !== null}
          aria-describedby={[newHintId, newError !== null ? newErrorId : null].filter((id) => id !== null).join(' ')}
        ></textarea>
        <span class="field-hint" id={newHintId}
          >{canWrite ? t('bodyEditHint') : t('commentDraftReadOnly', { workspace: t('workspace') })}</span
        >
        {#if newError !== null}
          <span class="field-error" id={newErrorId} role="alert"><Icon name="alert" />{newError}</span>
        {/if}
      </div>
      {#if canWrite}
        <div class="composer-foot">
          <button class="btn" type="submit" aria-disabled={sending}>{t('commentSend')}</button>
        </div>
      {/if}
    </form>
  {/if}
</div>

<ConfirmDialog
  bind:this={deleteDialog}
  title={t('commentDeleteTitle')}
  confirmLabel={t('taskDeleteConfirm')}
  cancelLabel={t('taskDeleteCancel')}
  danger
>
  <p>
    {t('commentDeleteText', {
      name:
        deleteTarget === null || deleteTarget.author.name === '' ? t('historyUnknownName') : deleteTarget.author.name,
      at: deleteTarget === null ? '' : formatHistoryTime(deleteTarget.created_at, timezone),
    })}
  </p>
</ConfirmDialog>
