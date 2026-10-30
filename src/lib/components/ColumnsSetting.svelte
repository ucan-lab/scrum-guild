<script lang="ts">
  import { tick } from 'svelte';
  import { page } from '$app/state';
  import { COLUMN_NAME_MAX_LENGTH, COLUMNS_PER_WORKSPACE, columnNameProblem } from '../../shared/column.ts';
  import {
    columnConflictReasonOf,
    columnCreate,
    columnDelete,
    columnMove,
    columnUpdate,
    type Column,
  } from '../../shared/operations/column/index.ts';
  import { moveConflictReasonOf } from '../../shared/operations/task/task-move.ts';
  import { callOperation, type ApiResult } from '../api.ts';
  import { ListDnd, type ListMove } from '../list-dnd.svelte.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import Icon from './Icon.svelte';
  import InlineEdit from './InlineEdit.svelte';
  import Setting from './Setting.svelte';

  // ワークスペースの設定の画面の、スプリントの列の節（見本は design/settings.html の列）。DefinitionsSetting と同じ作りで、行ごとにすぐ書く:
  // 足す（下の欄）、名前を直す（InlineEdit）、上へ／下へ（.order-actions。端の向きは aria-disabled）、行の先頭のつまみのドラッグ（ListDnd）、
  // 削除（確かめのダイアログを挟む）。書いた後は画面が一覧を読み直す（onchanged）。
  // 完了の列は一覧の末尾に固定の行（.fixed）で出し、動かせず、名前は直せず、削除もできない。名前は言葉づかいに合わせて辞書から出す
  // （リーダーが付けた列の名前は、言葉づかいを切り替えても訳さない）。
  // 完了以外の最後の1つの列は、削除ボタンを押せない（lockLast）。
  // 削除は、進行中と先のスプリントの未完了のタスクが残っているときだけ、移し先の列を選ぶ（既定は隣の列）。タスクが無ければ確かめだけ。
  // 足す、並べ替え、削除は1本ずつ送り、送っている間はほかの操作を押しても無視する（aria-disabled）。名前の確定は InlineEdit が
  // 二重に送らないので、ほかの操作と重なっても送る。閉じたワークスペース（canWrite が偽）では名前だけを読み取り専用で出す
  let {
    slug,
    workspaceId,
    columns,
    canWrite,
    onchanged,
    onstale,
  }: {
    slug: string;
    workspaceId: string;
    // column-list の列。完了の列は最後（name は空）
    columns: readonly Column[];
    canWrite: boolean;
    // 書いた（か、ほかの画面の変更を知った）後に、一覧を読み直す
    onchanged: () => Promise<void>;
    // ワークスペースが閉じていたか、見つからなかった。枠ごと読み直す
    onstale: () => void;
  } = $props();

  const ids = $props.id();
  const newId = `${ids}-new`;
  const newErrorId = `${ids}-new-error`;
  const targetId = `${ids}-target`;
  const lastHintId = `${ids}-last`;

  const items = $derived(columns.filter((column) => !column.is_done));
  const hasDone = $derived(columns.some((column) => column.is_done));
  const columnWord = $derived(t('column'));

  let newName = $state('');
  let addError = $state<string | null>(null);
  // 足す、並べ替え、削除を送っている間（名前の確定は数えない）
  let busy = $state(false);
  let status = $state('');
  let list = $state<HTMLOListElement>();
  let newInput = $state<HTMLInputElement>();
  let deleteDialog = $state<ReturnType<typeof ConfirmDialog>>();
  let deleting = $state<Column | null>(null);
  // 削除の移し先の列の ID
  let target = $state('');
  const targets = $derived(items.filter((column) => column.id !== deleting?.id));

  // 読み上げの領域の文。同じ文を続けて出しても読まれるよう、いったん空にしてから入れる
  async function announce(text: string): Promise<void> {
    status = '';
    await tick();
    status = text;
  }

  // 1本ずつ送る操作。送っている間は status に text を出し、終わったら消す
  async function exclusive(text: string, run: () => Promise<void>): Promise<boolean> {
    if (busy) return false;
    busy = true;
    status = text;
    try {
      await run();
    } finally {
      busy = false;
      if (status === text) status = '';
    }
    return true;
  }

  function nameProblem(raw: string): string | null {
    const problem = columnNameProblem(raw.trim());
    if (problem === 'required') return t('columnNameRequired');
    if (problem === 'too_long') return t('columnNameTooLong', { max: COLUMN_NAME_MAX_LENGTH });
    if (problem === 'invalid_character') return t('columnNameInvalidCharacter');
    return null;
  }

  // 断られた理由のうち、どの操作でも同じ扱いのもの。扱ったら true（呼ぶ側は読み直しだけをする）
  function handledCommon(result: ApiResult<unknown>): boolean {
    if (result.ok) return false;
    if (isUnauthenticated(result)) {
      window.location.assign(loginUrl(page.url));
      return true;
    }
    if (result.status === 409 && result.error?.code === 'workspace_closed') {
      showToast(t('workspaceClosedReadOnly', { workspace: t('workspace') }), 'alert');
      onstale();
      return true;
    }
    if (result.status === 404) {
      showToast(t('definitionGone', { kind: columnWord }), 'alert');
      return true;
    }
    return false;
  }

  // 名前の 409 の文。同じ名前と、数の上限と、読んでから書くまでに別の画面が変えたとき（changed）
  function conflictText(result: ApiResult<unknown>): string | null {
    if (result.ok || result.status !== 409 || result.error?.code !== 'conflict') return null;
    const reason = columnConflictReasonOf(result.error.details);
    if (reason === 'duplicate_name') return t('definitionDuplicate', { kind: columnWord });
    if (reason === 'limit') return t('definitionLimit', { kind: columnWord, max: COLUMNS_PER_WORKSPACE });
    if (reason === 'changed') return t('columnSaveChanged');
    return null;
  }

  function failureText(result: ApiResult<unknown>): string {
    return (
      conflictText(result) ??
      (!result.ok && result.status === 400
        ? t('definitionBadRequest')
        : t('definitionSaveFailed', { kind: columnWord }))
    );
  }

  async function add(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    addError = nameProblem(newName);
    if (addError !== null) {
      newInput?.focus();
      return;
    }
    const name = newName.trim();
    await exclusive(t('definitionSaving', { kind: columnWord }), async () => {
      const result = await callOperation(columnCreate, { workspace_id: workspaceId, name }, { slug });
      if (result.ok) {
        newName = '';
        showToast(t('definitionAdded', { name }), 'check');
        await onchanged();
        return;
      }
      // 足す操作の 404 は、ワークスペースが見つからない（消えた、入れなくなった）。枠ごと読み直す
      if (!isUnauthenticated(result) && result.status === 404) {
        showToast(t('definitionAddNotFound'), 'alert');
        onstale();
        return;
      }
      if (handledCommon(result)) return;
      addError = failureText(result);
      newInput?.focus();
    });
  }

  // 名前を直す（InlineEdit の save）。エラーの文か、成功の null を返す
  async function rename(item: Column, raw: string): Promise<string | null> {
    const name = raw.trim();
    if (name === item.name) return null;
    const result = await callOperation(columnUpdate, { workspace_id: workspaceId, column_id: item.id, name }, { slug });
    if (result.ok) {
      showToast(t('definitionSaved', { name }), 'check');
      await onchanged();
      return null;
    }
    if (handledCommon(result)) {
      await onchanged();
      return null;
    }
    return failureText(result);
  }

  // afterId の行の直後（null は先頭）へ動かして、読み直す。動かせたら true
  async function sendMove(item: Column, afterId: string | null): Promise<boolean> {
    let moved = false;
    await exclusive('', async () => {
      const result = await callOperation(
        columnMove,
        { workspace_id: workspaceId, column_id: item.id, after_column_id: afterId },
        { slug },
      );
      if (result.ok) moved = true;
      else if (!handledCommon(result)) {
        const reason = result.status === 409 ? moveConflictReasonOf(result.error?.details) : undefined;
        showToast(reason === 'changed' ? t('definitionChanged') : t('definitionMoveFailed'), 'alert');
      }
      await onchanged();
    });
    return moved;
  }

  // 1つ上か下へ動かす。動かした後は、同じ行の同じボタンへフォーカスを戻す（行の要素は並び替えで動く）
  async function move(index: number, delta: -1 | 1): Promise<void> {
    const item = items[index];
    const destination = index + delta;
    if (busy || item === undefined || destination < 0 || destination >= items.length) return;
    // 上へは2つ上の行の直後（先頭なら直前の行なし）、下へは次の行の直後
    const afterId = delta < 0 ? (items[index - 2]?.id ?? null) : items[index + 1]!.id;
    if (await sendMove(item, afterId)) {
      await announce(t('definitionMoved', { name: item.name, position: destination + 1 }));
    }
    await tick();
    list
      ?.querySelector<HTMLButtonElement>(
        `li[data-column-id="${CSS.escape(item.id)}"] [data-move="${delta < 0 ? 'up' : 'down'}"]`,
      )
      ?.focus();
  }

  // 行の先頭のつまみで落とした。「上へ」「下へ」と同じ送り方で、行き先の直前の行を渡す。
  // 動かせたら、読み直して動いた行を光らせて読み上げる。マウスの操作なので、フォーカスは動かさない
  async function dropTo(drop: ListMove): Promise<void> {
    const item = items.find((row) => row.id === drop.id);
    if (busy || item === undefined) return;
    if (!(await sendMove(item, drop.afterId ?? null))) return;
    dnd.flash(item.id);
    await announce(t('definitionMoved', { name: item.name, position: drop.index + 1 }));
  }

  // 完了以外の列のドラッグ。完了の行は一覧の ID に入れないので、つかめず、落とす先にもならない
  const dnd = new ListDnd({
    scope: ids,
    ids: () => items.map((item) => item.id),
    enabled: () => canWrite && !busy,
    onDrop: (drop) => void dropTo(drop),
  });
  $effect(() => dnd.monitor());

  // 削除の確かめ。移し先の既定は隣の列（1つ前、先頭なら次）
  async function remove(item: Column, index: number, trigger: HTMLElement): Promise<void> {
    if (busy || items.length <= 1) return;
    deleting = item;
    target = (items[index - 1] ?? items[index + 1])?.id ?? '';
    const confirmed = (await deleteDialog?.ask(trigger)) ?? false;
    if (!confirmed) return;
    const moveTo = item.task_count > 0 ? target : undefined;
    const destination = items.find((column) => column.id === moveTo);
    const started = await exclusive(t('definitionDeleting', { kind: columnWord }), async () => {
      const result = await callOperation(
        columnDelete,
        { workspace_id: workspaceId, column_id: item.id, target_column_id: moveTo },
        { slug },
      );
      if (result.ok) {
        showToast(
          result.data.moved_count > 0 && destination !== undefined
            ? t('columnDeletedMoved', {
                name: item.name,
                count: result.data.moved_count,
                task: t('task'),
                target: destination.name,
              })
            : t('definitionDeleted', { name: item.name }),
          'check',
        );
      } else if (!isUnauthenticated(result) && result.status === 404) {
        // 404 は削除する列か移し先のどちらか。どちらとは言えないので、両方を指す
        showToast(t('columnDeleteNotFound', { column: columnWord }), 'alert');
      } else if (!handledCommon(result)) {
        const reason = result.status === 409 ? columnConflictReasonOf(result.error?.details) : undefined;
        showToast(deleteFailureText(result.status, reason), 'alert');
      }
      await onchanged();
    });
    if (!started) return;
    // 押したボタンは行ごと消えるので、同じ位置の行（無ければ前の行）の削除ボタンへ、一覧が空なら足す欄へフォーカスを移す
    await tick();
    const buttons = list?.querySelectorAll<HTMLButtonElement>('[data-delete]') ?? [];
    const next = buttons[Math.min(index, buttons.length - 1)];
    (next ?? newInput)?.focus();
  }

  function deleteFailureText(status: number, reason: ReturnType<typeof columnConflictReasonOf>): string {
    if (reason === 'last_column') return t('columnDeleteLast', { column: columnWord });
    if (reason === 'target_required') return t('columnDeleteTargetRequired', { task: t('task') });
    if (reason === 'target_invalid') return t('columnDeleteTargetInvalid', { column: columnWord });
    if (status === 409) return t('definitionChanged');
    return t('definitionDeleteFailed');
  }
</script>

<Setting
  title={columnWord}
  description={t('columnsDesc', { sprint: t('sprint'), column: columnWord, task: t('task') })}
>
  <ol class="order-list" aria-label={t('definitionListLabel', { kind: columnWord })} bind:this={list}>
    {#each items as item, index (item.id)}
      <li
        class:is-dragging={dnd.dragging === item.id}
        class:is-dropped={dnd.isFlashing(item.id)}
        data-column-id={item.id}
        data-drop={dnd.markOf(item.id)}
        {@attach canWrite ? dnd.target(item.id) : undefined}
      >
        <!-- つかむのは先頭のつまみだけ（飾りで aria-hidden。キーボードと読み上げの人は「上へ」「下へ」）。
             書き込めない一覧には出さない。送っている間は出したまま、つかめない（enabled が偽） -->
        {#if canWrite}
          <span class="grip" aria-hidden="true" {@attach dnd.handle(item.id)}><Icon name="grip" /></span>
        {/if}
        <div class="order-main">
          {#if canWrite}
            <div class="order-name">
              <InlineEdit
                value={item.name}
                label={t('definitionNameLabel', { kind: columnWord })}
                labelHidden
                problem={nameProblem}
                save={(raw) => rename(item, raw)}
                normalize={(raw) => raw.trim()}
              >
                {#snippet view(begin)}
                  <button class="edit-trigger" type="button" onclick={begin}>
                    <span>{item.name}</span>
                    <Icon name="pen" />
                    <span class="visually-hidden">{t('definitionRenameHint')}</span>
                  </button>
                {/snippet}
              </InlineEdit>
            </div>
          {:else}
            <span class="order-name">{item.name}</span>
          {/if}
          {#if canWrite && items.length > 1 && item.task_count > 0}
            <span class="props-note">{t('columnTaskCount', { count: item.task_count })}</span>
          {/if}
        </div>
        {#if canWrite}
          <span class="order-actions">
            <button
              class="icon-btn"
              type="button"
              data-move="up"
              aria-label={t('moveUpLabel', { title: item.name })}
              title={t('moveUp')}
              aria-disabled={busy || index === 0}
              onclick={() => void move(index, -1)}><Icon name="up" /></button
            >
            <button
              class="icon-btn"
              type="button"
              data-move="down"
              aria-label={t('moveDownLabel', { title: item.name })}
              title={t('moveDown')}
              aria-disabled={busy || index === items.length - 1}
              onclick={() => void move(index, 1)}><Icon name="down" /></button
            >
            <button
              class="icon-btn is-danger"
              type="button"
              data-delete
              aria-label={t('definitionDeleteLabel', { name: item.name })}
              title={t('definitionDeleteAction')}
              aria-disabled={busy || items.length <= 1}
              aria-describedby={items.length <= 1 ? lastHintId : undefined}
              onclick={(event) => void remove(item, index, event.currentTarget)}><Icon name="trash" /></button
            >
          </span>
        {/if}
      </li>
    {/each}
    {#if hasDone}
      <!-- 完了の列は常に末尾。動かせず、名前も直せず、削除もできない。名前は言葉づかいに合わせて辞書から出す -->
      <li data-done-column>
        {#if canWrite}<span class="grip is-off" aria-hidden="true"></span>{/if}
        <span class="fixed"><Icon name="check" />{t('done')}</span>
        <span class="props-note">{t('columnDoneNote')}</span>
      </li>
    {/if}
  </ol>
  <!-- 削除ボタンを押せない理由。title だけにせず見える文字にして、ボタンに aria-describedby で結ぶ -->
  {#if canWrite && items.length === 1}
    <p class="props-note" id={lastHintId}>{t('columnDeleteLastHint', { column: columnWord })}</p>
  {/if}

  {#if canWrite}
    <!-- 欄の下にエラーが出ても「足す」がずれないよう、入力欄とボタンを1行（.input-row）にまとめる -->
    <form class="field" class:is-invalid={addError !== null} onsubmit={add} novalidate>
      <label class="field-label" for={newId}>{t('definitionNewLabel', { kind: columnWord })}</label>
      <div class="input-row">
        <input
          class="input"
          id={newId}
          bind:this={newInput}
          bind:value={newName}
          oninput={() => (addError = null)}
          readonly={busy}
          autocomplete="off"
          aria-invalid={addError !== null}
          aria-describedby={addError !== null ? newErrorId : undefined}
        />
        <button class="btn" type="submit" aria-disabled={busy}>
          <Icon name="plus" />{t('definitionAdd', { kind: columnWord })}
        </button>
      </div>
      {#if addError !== null}
        <span class="field-error" id={newErrorId} role="alert"><Icon name="alert" />{addError}</span>
      {/if}
    </form>
  {/if}
  <!-- 送っている間と動かした結果の読み上げ。領域は常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{status}</span>
</Setting>

<ConfirmDialog
  bind:this={deleteDialog}
  title={t('definitionDeleteTitle', { name: deleting?.name ?? '' })}
  confirmLabel={t('definitionDeleteConfirm')}
  cancelLabel={t('cancel')}
  danger
>
  {#if deleting !== null && deleting.task_count > 0}
    <p>
      {t('columnDeleteText', {
        count: deleting.task_count,
        task: t('task'),
        column: columnWord,
        sprint: t('sprint'),
      })}
    </p>
    <div class="field">
      <label class="field-label" for={targetId}>{t('columnDeleteTarget', { column: columnWord })}</label>
      <select class="select" id={targetId} bind:value={target}>
        {#each targets as option (option.id)}
          <option value={option.id}>{option.name}</option>
        {/each}
      </select>
    </div>
  {:else}
    <p>{t('columnDeleteTextEmpty', { task: t('task'), column: columnWord, sprint: t('sprint') })}</p>
  {/if}
</ConfirmDialog>
