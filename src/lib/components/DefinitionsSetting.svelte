<script lang="ts">
  import { tick } from 'svelte';
  import { page } from '$app/state';
  import {
    DEFINITION_NAME_MAX_LENGTH,
    DEFINITIONS_PER_WORKSPACE,
    DETAIL_FIELDS_PER_WORKSPACE,
    definitionNameProblem,
  } from '../../shared/definition.ts';
  import {
    categoryCreate,
    categoryDelete,
    categoryMove,
    categoryUpdate,
    definitionConflictReasonOf,
    detailFieldCreate,
    detailFieldDelete,
    detailFieldMove,
    detailFieldUpdate,
    repositoryCreate,
    repositoryDelete,
    repositoryMove,
    repositoryUpdate,
  } from '../../shared/operations/definition/index.ts';
  import { moveConflictReasonOf } from '../../shared/operations/task/task-move.ts';
  import { callOperation, type ApiResult } from '../api.ts';
  import { ListDnd, type ListMove } from '../list-dnd.svelte.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import EmptyState from './EmptyState.svelte';
  import Icon from './Icon.svelte';
  import InlineEdit from './InlineEdit.svelte';
  import Setting from './Setting.svelte';

  // ワークスペースの設定の画面の、区分（kind = 'category'）とリポジトリ（kind = 'repository'）と、タスクの決まった欄（kind = 'field'）の節
  // （見本は design/settings.html）。決まった欄は 10 件までで（区分とリポジトリは 50 件）、名前を直しても値は残り、
  // 削除は論理削除だけ（値は残るが、削除した欄は引き出しに出ず、未記入の判定から外れる）。
  // 見本の「保存する」でまとめる形は採らず、行ごとにすぐ書く: 足す（下の欄）、名前を直す（InlineEdit）、月ごとに計上するの切り替え（区分だけ）、
  // 上へ／下へ（.order-actions。端の向きは aria-disabled）、削除（確かめのダイアログを挟む）。書いた後は画面が一覧を読み直す（onchanged）。
  // 足す、切り替え、並べ替え、削除は1本ずつ送り、送っている間はほかの操作を押しても無視する（aria-disabled）。名前の確定は InlineEdit が
  // 二重に送らないので、ほかの操作と重なっても送る。閉じたワークスペース（canWrite が偽）では名前だけを読み取り専用で出す。
  // 行の先頭のつまみのドラッグ（ListDnd）でも並べ替えられる。落としたら、上へ／下へと同じ送り方で、行き先の直前の行を渡す。
  // 送っている間（busy）はつかめない。取り込み元の入る先との結び付けは #67 で足す
  type Item = { id: string; name: string; is_billed_monthly?: boolean };

  let {
    kind,
    slug,
    workspaceId,
    items,
    canWrite,
    onchanged,
    onstale,
  }: {
    kind: 'category' | 'repository' | 'field';
    slug: string;
    workspaceId: string;
    items: readonly Item[];
    canWrite: boolean;
    // 書いた（か、ほかの画面の変更を知った）後に、一覧を読み直す
    onchanged: () => Promise<void>;
    // ワークスペースが閉じていたか、見つからなかった。枠ごと読み直す
    onstale: () => void;
  } = $props();

  const ids = $props.id();
  const newId = `${ids}-new`;
  const newErrorId = `${ids}-new-error`;

  const kindWord = $derived(
    kind === 'category' ? t('category') : kind === 'repository' ? t('repository') : t('detailFieldKind'),
  );
  // 数の上限（決まった欄は 10 件、区分とリポジトリは 50 件）
  const limit = $derived(kind === 'field' ? DETAIL_FIELDS_PER_WORKSPACE : DEFINITIONS_PER_WORKSPACE);
  let newName = $state('');
  let addError = $state<string | null>(null);
  // 足す、切り替え、並べ替え、削除を送っている間（名前の確定は数えない）
  let busy = $state(false);
  let status = $state('');
  let list = $state<HTMLOListElement>();
  let newInput = $state<HTMLInputElement>();
  let deleteDialog = $state<ReturnType<typeof ConfirmDialog>>();
  let deleting = $state<Item | null>(null);

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
    const problem = definitionNameProblem(raw.trim());
    if (problem === 'required') return t('workspaceNameRequired');
    if (problem === 'too_long') return t('workspaceNameTooLong', { max: DEFINITION_NAME_MAX_LENGTH });
    if (problem === 'invalid_character') return t('workspaceNameInvalidCharacter');
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
      showToast(t('definitionGone', { kind: kindWord }), 'alert');
      return true;
    }
    return false;
  }

  // 名前の 409 の文。同じ名前と、数の上限
  function conflictText(result: ApiResult<unknown>): string | null {
    if (result.ok || result.status !== 409 || result.error?.code !== 'conflict') return null;
    const reason = definitionConflictReasonOf(result.error.details);
    if (reason === 'duplicate_name') return t('definitionDuplicate', { kind: kindWord });
    if (reason === 'limit') return t('definitionLimit', { kind: kindWord, max: limit });
    return null;
  }

  function failureText(result: ApiResult<unknown>): string {
    return (
      conflictText(result) ??
      (!result.ok && result.status === 400 ? t('definitionBadRequest') : t('definitionSaveFailed', { kind: kindWord }))
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
    await exclusive(t('definitionSaving', { kind: kindWord }), async () => {
      const result =
        kind === 'category'
          ? await callOperation(categoryCreate, { workspace_id: workspaceId, name }, { slug })
          : kind === 'repository'
            ? await callOperation(repositoryCreate, { workspace_id: workspaceId, name }, { slug })
            : await callOperation(detailFieldCreate, { workspace_id: workspaceId, name }, { slug });
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
  async function rename(item: Item, raw: string): Promise<string | null> {
    const name = raw.trim();
    if (name === item.name) return null;
    const result =
      kind === 'category'
        ? await callOperation(categoryUpdate, { workspace_id: workspaceId, category_id: item.id, name }, { slug })
        : kind === 'repository'
          ? await callOperation(repositoryUpdate, { workspace_id: workspaceId, repository_id: item.id, name }, { slug })
          : await callOperation(detailFieldUpdate, { workspace_id: workspaceId, field_id: item.id, name }, { slug });
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

  // 月ごとに計上するかを切り替える（区分だけ）。送っている間の押下は、切り替えずに無視する
  function guardToggle(event: MouseEvent): void {
    if (busy) event.preventDefault();
  }

  async function toggleBilled(item: Item, event: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const input = event.currentTarget;
    const next = input.checked;
    const started = await exclusive(t('definitionSaving', { kind: kindWord }), async () => {
      const result = await callOperation(
        categoryUpdate,
        { workspace_id: workspaceId, category_id: item.id, is_billed_monthly: next },
        { slug },
      );
      if (result.ok) {
        showToast(t('definitionSaved', { name: item.name }), 'check');
      } else {
        input.checked = item.is_billed_monthly === true;
        if (!handledCommon(result)) showToast(t('definitionSaveFailed', { kind: kindWord }), 'alert');
      }
      await onchanged();
    });
    if (!started) input.checked = !next;
  }

  // afterId の行の直後（null は先頭）へ動かして、読み直す。動かせたら true
  async function sendMove(item: Item, afterId: string | null): Promise<boolean> {
    let moved = false;
    await exclusive('', async () => {
      const result =
        kind === 'category'
          ? await callOperation(
              categoryMove,
              { workspace_id: workspaceId, category_id: item.id, after_category_id: afterId },
              { slug },
            )
          : kind === 'repository'
            ? await callOperation(
                repositoryMove,
                { workspace_id: workspaceId, repository_id: item.id, after_repository_id: afterId },
                { slug },
              )
            : await callOperation(
                detailFieldMove,
                { workspace_id: workspaceId, field_id: item.id, after_field_id: afterId },
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
    const target = index + delta;
    if (busy || item === undefined || target < 0 || target >= items.length) return;
    // 上へは2つ上の行の直後（先頭なら直前の行なし）、下へは次の行の直後
    const afterId = delta < 0 ? (items[index - 2]?.id ?? null) : items[index + 1]!.id;
    if (await sendMove(item, afterId)) await announce(t('definitionMoved', { name: item.name, position: target + 1 }));
    await tick();
    list
      ?.querySelector<HTMLButtonElement>(
        `li[data-definition-id="${CSS.escape(item.id)}"] [data-move="${delta < 0 ? 'up' : 'down'}"]`,
      )
      ?.focus();
  }

  // 行の先頭のつまみで落とした。「上へ」「下へ」と同じ送り方（category-move、repository-move）で、行き先の直前の行を渡す。
  // 動かせたら、読み直して動いた行を光らせて読み上げる。マウスの操作なので、フォーカスは動かさない
  async function dropTo(drop: ListMove): Promise<void> {
    const item = items.find((row) => row.id === drop.id);
    if (busy || item === undefined) return;
    if (!(await sendMove(item, drop.afterId ?? null))) return;
    dnd.flash(item.id);
    await announce(t('definitionMoved', { name: item.name, position: drop.index + 1 }));
  }

  // 一覧の行のドラッグ。scope は、この一覧だけの行を受け付けるための名前（区分の一覧とリポジトリの一覧は別）
  const dnd = new ListDnd({
    scope: ids,
    ids: () => items.map((item) => item.id),
    enabled: () => canWrite && !busy,
    onDrop: (drop) => void dropTo(drop),
  });
  $effect(() => dnd.monitor());

  async function remove(item: Item, index: number, trigger: HTMLElement): Promise<void> {
    if (busy) return;
    deleting = item;
    const confirmed = (await deleteDialog?.ask(trigger)) ?? false;
    if (!confirmed) return;
    const started = await exclusive(t('definitionDeleting', { kind: kindWord }), async () => {
      const result =
        kind === 'category'
          ? await callOperation(categoryDelete, { workspace_id: workspaceId, category_id: item.id }, { slug })
          : kind === 'repository'
            ? await callOperation(repositoryDelete, { workspace_id: workspaceId, repository_id: item.id }, { slug })
            : await callOperation(detailFieldDelete, { workspace_id: workspaceId, field_id: item.id }, { slug });
      if (result.ok) showToast(t('definitionDeleted', { name: item.name }), 'check');
      else if (!handledCommon(result)) {
        showToast(result.status === 409 ? t('definitionChanged') : t('definitionDeleteFailed'), 'alert');
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
</script>

<Setting
  title={kind === 'field' ? t('detailFieldsTitle', { detail: t('detail') }) : kindWord}
  description={kind === 'category'
    ? t('categoriesDesc', { epic: t('epic'), category: t('category') })
    : kind === 'repository'
      ? t('repositoriesDesc', { task: t('task') })
      : t('detailFieldsDesc', { task: t('task'), detail: t('detail') })}
>
  {#if items.length === 0}
    <EmptyState
      icon={kind === 'category' ? 'tag' : kind === 'repository' ? 'git' : 'pen'}
      title={canWrite
        ? t('definitionEmptyTitle', { kind: kindWord })
        : t('definitionEmptyReadOnly', { kind: kindWord })}
      text={canWrite ? t('definitionEmptyText') : undefined}
    />
  {:else}
    <ol class="order-list" aria-label={t('definitionListLabel', { kind: kindWord })} bind:this={list}>
      {#each items as item, index (item.id)}
        <li
          class:is-dragging={dnd.dragging === item.id}
          class:is-dropped={dnd.isFlashing(item.id)}
          data-definition-id={item.id}
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
                  label={t('definitionNameLabel', { kind: kindWord })}
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
              {#if kind === 'category'}
                <label class="toggle">
                  <input
                    type="checkbox"
                    checked={item.is_billed_monthly === true}
                    aria-label={t('categoryBilledMonthlyLabel', { name: item.name })}
                    aria-disabled={busy}
                    onclick={guardToggle}
                    onchange={(event) => void toggleBilled(item, event)}
                  />
                  <span aria-hidden="true">{t('categoryBilledMonthly')}</span>
                </label>
              {/if}
            {:else}
              <span class="order-name">{item.name}</span>
              {#if kind === 'category' && item.is_billed_monthly === true}
                <span class="props-note">{t('categoryBilledMonthly')}</span>
              {/if}
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
                aria-disabled={busy}
                onclick={(event) => void remove(item, index, event.currentTarget)}><Icon name="trash" /></button
              >
            </span>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}

  {#if canWrite}
    <!-- 欄の下にエラーが出ても「足す」がずれないよう、入力欄とボタンを1行（.input-row）にまとめる -->
    <form class="field" class:is-invalid={addError !== null} onsubmit={add} novalidate>
      <label class="field-label" for={newId}>{t('definitionNewLabel', { kind: kindWord })}</label>
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
          <Icon name="plus" />{t('definitionAdd', { kind: kindWord })}
        </button>
      </div>
      {#if addError !== null}
        <span class="field-error" id={newErrorId} role="alert"><Icon name="alert" />{addError}</span>
      {/if}
      <!-- 決まった欄の上限は、押す前に文で示す（超えると足せない） -->
      {#if kind === 'field'}
        <span class="field-hint">{t('detailFieldsLimitNote', { kind: kindWord, count: items.length, max: limit })}</span
        >
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
  <p>
    {kind === 'category'
      ? t('categoryDeleteText', { epic: t('epic'), story: t('story'), task: t('task'), category: t('category') })
      : kind === 'repository'
        ? t('repositoryDeleteText', { task: t('task') })
        : t('detailFieldDeleteText', { task: t('task'), detail: t('detail') })}
  </p>
</ConfirmDialog>
