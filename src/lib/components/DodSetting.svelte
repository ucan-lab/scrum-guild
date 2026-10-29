<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    DEFINITION_OF_DONE_MAX_LENGTH,
    definitionOfDoneProblem,
    workspaceDodUpdate,
  } from '../../shared/operations/workspace/workspace-dod-update.ts';
  import { normalizeLongText } from '../../shared/story.ts';
  import { callOperation } from '../api.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import Icon from './Icon.svelte';
  import Markdown from './Markdown.svelte';
  import Setting from './Setting.svelte';

  // ワークスペースの設定の画面の、完成の定義の節（見本は design/settings.html の「完成の定義」）。
  // Markdown の欄と「保存する」。空にして保存すると空（null）になり、どこにも出さない。保存は workspace-dod-update で、
  // 書いた後は画面が枠（app:workspace）を読み直す（onsaved。バックログの画面と詳細の引き出しは、枠の値を出す）。
  // 欄の値は、保存した値（value）から変えていない間だけ、読み直した値に合わせる（変えている途中の文は上書きしない）。
  // 書きかけ（保存した値から変えた文。送っている間も数える）があるまま別の画面へ移る（左のメニュー、戻る／進む）ときは、
  // 詳細の引き出しと同じく、捨てるかをアプリの中のダイアログで確かめる。同じ画面のままの移動（`?task=` で引き出しを開くなど）は通す。
  // ページを離れる（タブを閉じる、外のサイト）ときは、cancel() がブラウザの確認を出す。
  // 閉じたワークスペース（canWrite が偽）では、欄を出さずに Markdown で読み取り専用に出す
  let {
    slug,
    workspaceId,
    value,
    canWrite,
    onsaved,
    onstale,
  }: {
    slug: string;
    workspaceId: string;
    // 保存されている完成の定義。空なら null
    value: string | null;
    canWrite: boolean;
    // 保存した。枠を読み直す
    onsaved: () => Promise<void>;
    // ワークスペースが閉じていたか、見つからない、操作できない。枠ごと読み直す
    onstale: () => void;
  } = $props();

  const ids = $props.id();
  const fieldId = `${ids}-field`;
  const hintId = `${ids}-hint`;
  const errorId = `${ids}-error`;

  // 欄の文と、欄が今もとにしている保存した値。読み直した値（value）が替わったら、欄を変えていなければ合わせる
  let draft = $state(untrack(() => value ?? ''));
  let base = $state(untrack(() => value));
  let seen = untrack(() => value);
  $effect.pre(() => {
    const next = value;
    if (next === seen) return;
    seen = next;
    untrack(() => {
      if (normalizeLongText(draft) === base) draft = next ?? '';
      base = next;
    });
  });

  let sending = $state(false);
  let error = $state<{ text: string; invalid: boolean } | null>(null);
  let status = $state('');
  let field = $state<HTMLTextAreaElement>();

  const dod = $derived(t('dod'));
  const changed = $derived(normalizeLongText(draft) !== base);

  // ---- 書きかけのまま移るときの確かめ（TaskDrawer と同じ扱い） ----
  let discardDialog = $state<ReturnType<typeof ConfirmDialog>>();
  let asking = false;
  let leaving = false;
  beforeNavigate((navigation) => {
    if (leaving || !canWrite || !(changed || sending)) return;
    if (navigation.to === null) {
      navigation.cancel();
      return;
    }
    const to = navigation.to.url;
    if (to.origin === location.origin && to.pathname === location.pathname) return;
    const delta = navigation.type === 'popstate' ? navigation.delta : undefined;
    navigation.cancel();
    if (asking) return;
    asking = true;
    void (discardDialog?.ask() ?? Promise.resolve(false))
      .then((discard) => {
        if (!discard) return;
        leaving = true;
        if (to.origin !== location.origin) location.href = to.href;
        else if (delta !== undefined && delta !== 0) history.go(delta);
        // eslint-disable-next-line svelte/no-navigation-without-resolve -- 行き先は SvelteKit が解決した URL（navigation.to）で、経路から作り直せない
        else void goto(to);
      })
      .finally(() => {
        asking = false;
      });
  });

  function problemText(normalized: string | null): string | null {
    const problem = normalized === null ? null : definitionOfDoneProblem(normalized);
    if (problem === 'too_long') {
      return t('dodTooLong', { dod, max: DEFINITION_OF_DONE_MAX_LENGTH.toLocaleString('ja-JP') });
    }
    if (problem === 'invalid_character') return t('dodInvalidCharacter', { dod });
    return null;
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (sending) return;
    const normalized = normalizeLongText(draft);
    status = '';
    if (normalized === base) {
      error = null;
      await tick();
      status = t('dodUnchanged');
      return;
    }
    const problem = problemText(normalized);
    if (problem !== null) {
      error = { text: problem, invalid: true };
      field?.focus();
      return;
    }
    error = null;
    sending = true;
    status = t('dodSaving', { dod });
    try {
      const result = await callOperation(
        workspaceDodUpdate,
        { workspace_id: workspaceId, definition_of_done_md: draft },
        { slug },
      );
      if (result.ok) {
        const saved = result.data.definition_of_done_md;
        base = saved;
        draft = saved ?? '';
        // 枠の読み直しを待つ間に「保存しています」を残さない
        sending = false;
        status = '';
        showToast(saved === null ? t('dodCleared', { dod }) : t('dodSaved', { dod }), 'check');
        await onsaved();
        return;
      }
      if (isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      if (result.status === 409 && result.error?.code === 'workspace_closed') {
        showToast(t('workspaceClosedReadOnly', { workspace: t('workspace') }), 'alert');
        onstale();
        return;
      }
      if (result.status === 403 || result.status === 404) {
        error = { text: t('dodUnavailable'), invalid: false };
        onstale();
        return;
      }
      if (result.status === 409) {
        error = { text: t('dodConflict', { dod }), invalid: false };
        status = '';
        await onsaved();
        return;
      }
      // 400 は画面の検査を通った後なので、理由を決めつけず、ほかの失敗と同じ文にする
      error = { text: t('dodSaveFailed', { dod }), invalid: false };
    } finally {
      sending = false;
      if (status === t('dodSaving', { dod })) status = '';
    }
  }
</script>

<Setting
  title={dod}
  description={t('dodDesc', {
    task: t('task'),
    backlog: t('backlog'),
    sprint: t('sprint'),
    done: t('done'),
    column: t('column'),
  })}
>
  {#if canWrite}
    <form class="field" class:is-invalid={error?.invalid === true} onsubmit={save} novalidate>
      <label class="field-label" for={fieldId}>{t('dodFieldLabel')}</label>
      <textarea
        class="textarea"
        id={fieldId}
        rows="8"
        bind:this={field}
        bind:value={draft}
        oninput={() => {
          error = null;
          status = '';
        }}
        readonly={sending}
        aria-invalid={error?.invalid === true}
        aria-describedby={[hintId, error !== null ? errorId : null].filter((id) => id !== null).join(' ')}></textarea>
      <span class="field-hint" id={hintId}>{t('dodHint')}</span>
      {#if error !== null}
        <span class="field-error" id={errorId} role="alert"><Icon name="alert" />{error.text}</span>
      {/if}
      <div class="form-actions">
        <button class="btn is-primary" type="submit" aria-disabled={sending || !changed}>{t('dodSave')}</button>
        <!-- 送っている間と、変えずに押したときの知らせ。領域は常に置き、中の文字だけを替える -->
        <span class="field-hint" role="status">{status}</span>
      </div>
    </form>
  {:else if value !== null}
    <Markdown source={value} />
  {:else}
    <div class="doc-box is-empty">{t('dodEmptyReadOnly', { dod })}</div>
  {/if}
</Setting>

<ConfirmDialog
  bind:this={discardDialog}
  title={t('discardTitle')}
  confirmLabel={t('discardConfirm')}
  cancelLabel={t('discardKeep')}
  danger
>
  <p>{t('discardText')}</p>
</ConfirmDialog>
