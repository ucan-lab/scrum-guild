<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // kit.js の drawerTitleHtml / drawerLinkHtml / drawerBodyHtml の「押すと入力欄に替わる」動き。
  // view が読む形（値そのものが押せるボタン、または描いた本文と「編集」）で、押したときに begin を呼ぶと入力欄と「保存」「取り消し」に替わる。
  // 読む形は、直している間も DOM に残して隠す（引き出しの名前を指す要素が消えないように）。
  // 1行の欄は Enter か「保存」で確定、Esc か「取り消し」で元に戻す（Esc は preventDefault するので、引き出しは閉じない）。
  // 本文（multiline）は Enter が改行なので「保存」だけで確定し、Esc は引き出しの閉じる操作に任せる（書きかけは閉じる側が確かめる）。
  // 書きかけ（直している途中で、値が保存した値と違う）は ondirty で親に伝える。
  // save は確定の処理で、エラーの文（画面に出す）か、成功の null を返す。送っている間は欄を readonly にし、ボタンを aria-disabled にして
  // フォーカスを残す。確定か取り消しの後は、読む形の押したボタンへフォーカスを戻す
  let {
    value,
    label,
    labelHidden = false,
    multiline = false,
    inputType = 'text',
    placeholder,
    hint,
    problem,
    save,
    normalize = (raw) => raw,
    ondirty,
    view,
  }: {
    // 保存した値。空は空の文字
    value: string;
    // 入力欄の名前
    label: string;
    labelHidden?: boolean;
    multiline?: boolean;
    inputType?: 'text' | 'url';
    placeholder?: string;
    hint?: string;
    // 画面の検査。エラーの文か、null
    problem: (raw: string) => string | null;
    save: (raw: string) => Promise<string | null>;
    // 保存するときの整え方（前後の空白、空は同じ、など）。書きかけの判定は、整えた値どうしで比べる
    normalize?: (raw: string) => string;
    // 書きかけがあるかが変わるたびに呼ぶ
    ondirty?: (dirty: boolean) => void;
    view: Snippet<[begin: (event: Event) => void]>;
  } = $props();

  const ids = $props.id();
  const inputId = `${ids}-input`;
  const hintId = `${ids}-hint`;
  const errorId = `${ids}-error`;

  let editing = $state(false);
  let draft = $state('');
  let error = $state<string | null>(null);
  let saving = $state(false);
  let trigger: HTMLElement | null = null;
  let input = $state<HTMLInputElement | HTMLTextAreaElement>();

  // 書きかけは、保存と同じ整え方（normalize）の後で、保存した値と違うもの。送っている間も数える
  // （失敗したときに入力が消えないよう、閉じる前に確かめる。通れば保存した値と同じになり、書きかけでなくなる）
  $effect(() => {
    ondirty?.(editing && normalize(draft) !== normalize(value));
  });
  // 部品が外れたら（欄が読み取り専用に替わったなど）、書きかけは無くなる
  $effect(() => () => ondirty?.(false));

  async function begin(event: Event): Promise<void> {
    if (editing) return;
    trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    draft = value;
    error = null;
    editing = true;
    await tick();
    input?.focus();
    // 続きから書けるよう、カーソルを末尾に置く
    input?.setSelectionRange(draft.length, draft.length);
  }

  async function finish(): Promise<void> {
    editing = false;
    error = null;
    await tick();
    trigger?.focus();
  }

  function cancel(): void {
    if (saving) return;
    void finish();
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (saving) return;
    error = problem(draft);
    if (error !== null) {
      input?.focus();
      return;
    }
    saving = true;
    try {
      error = await save(draft);
      if (error === null) await finish();
      else input?.focus();
    } finally {
      saving = false;
    }
  }

  // 1行の欄の Enter と Esc。変換中（keyCode 229 は、isComposing が偽になる確定直後も含む）の Enter は変換の確定、Esc は変換の取り消しなので、
  // 送らず、戻さない
  function onkeydown(event: KeyboardEvent): void {
    const composing = event.isComposing || event.keyCode === 229;
    if (event.key === 'Enter' && composing) {
      event.preventDefault();
      return;
    }
    if (multiline || event.key !== 'Escape' || composing) return;
    event.preventDefault();
    cancel();
  }
</script>

<div class="edit-view" hidden={editing}>{@render view(begin)}</div>
{#if editing}
  <form class="edit-form" onsubmit={submit} novalidate>
    <div class="field" class:is-invalid={error !== null}>
      <label class="field-label" class:visually-hidden={labelHidden} for={inputId}>{label}</label>
      {#if multiline}
        <textarea
          class="textarea"
          id={inputId}
          bind:this={input}
          bind:value={draft}
          oninput={() => (error = null)}
          readonly={saving}
          {placeholder}
          aria-invalid={error !== null}
          aria-describedby={[hint !== undefined ? hintId : null, error !== null ? errorId : null]
            .filter((id) => id !== null)
            .join(' ') || undefined}></textarea>
      {:else}
        <input
          class="input"
          id={inputId}
          type={inputType}
          bind:this={input}
          bind:value={draft}
          oninput={() => (error = null)}
          {onkeydown}
          readonly={saving}
          {placeholder}
          autocomplete="off"
          aria-invalid={error !== null}
          aria-describedby={[hint !== undefined ? hintId : null, error !== null ? errorId : null]
            .filter((id) => id !== null)
            .join(' ') || undefined}
        />
      {/if}
      {#if hint !== undefined}<span class="field-hint" id={hintId}>{hint}</span>{/if}
      {#if error !== null}
        <span class="field-error" id={errorId} role="alert"><Icon name="alert" />{error}</span>
      {/if}
    </div>
    <div class="edit-actions">
      <button class="btn is-primary is-sm" type="submit" aria-disabled={saving}>{t('editSave')}</button>
      <button class="btn is-sm is-quiet" type="button" aria-disabled={saving} onclick={cancel}>{t('editCancel')}</button
      >
    </div>
    <span class="visually-hidden" role="status">{saving ? t('taskSaving') : ''}</span>
  </form>
{/if}
