<script lang="ts">
  import { tick } from 'svelte';
  import type { BacklogTask } from '../../shared/operations/task/backlog-tree.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';

  // タスクの親を移すダイアログ。移す先は、親なしと、stories（画面が渡す、完了していない親のないストーリー）のうち今の親でないもの。
  // show(trigger, task, storyId) で、動かすタスクと今の親（null は親なし）を渡して開く。
  // 「移す」を押したら閉じて、onmove に動かすタスクと移す先を渡す。送るのと失敗の扱いは画面が持つ（並べ替えと同じく、先に画面を動かす）。
  // 移す先の末尾に置く（API には直前の行を送らない）
  let {
    stories,
    onmove,
  }: {
    stories: readonly { id: string; title: string }[];
    onmove: (task: BacklogTask, storyId: string | null) => void;
  } = $props();

  const ids = $props.id();
  const formId = `${ids}-form`;
  const targetId = `${ids}-target`;
  const hintId = `${ids}-hint`;
  // 親なしの選択肢の値。ストーリーの ID とぶつからない
  const NONE = '';

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let task = $state<BacklogTask | null>(null);
  let current = $state<string | null>(null);
  let choice = $state(NONE);

  const candidates = $derived(stories.filter((story) => story.id !== current));

  export function show(trigger: HTMLElement | null, target: BacklogTask, storyId: string | null): void {
    task = target;
    current = storyId;
    // 今が親なしなら、最初のストーリーを選んでおく
    choice = storyId === null ? (candidates[0]?.id ?? NONE) : NONE;
    dialog?.show(trigger);
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (task === null) return;
    const moving = task;
    const storyId = choice === NONE ? null : choice;
    open = false;
    // 今の親のままなら、何も送らずに閉じる
    if (storyId === current) return;
    // ダイアログが閉じて画面に戻ってから渡す（画面が、作り直した行へフォーカスを移せるように）
    await tick();
    onmove(moving, storyId);
  }
</script>

<Dialog bind:this={dialog} bind:open title={t('moveParentTitle', { title: task?.title ?? '' })}>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    <div class="field">
      <label class="field-label" for={targetId}>{t('moveParentField')}</label>
      <select class="select" id={targetId} bind:value={choice} aria-describedby={hintId}>
        {#if current !== null}
          <option value={NONE}>{t('moveParentNone')}</option>
        {/if}
        {#each candidates as option (option.id)}
          <option value={option.id}>{option.title}</option>
        {/each}
      </select>
      <span class="field-hint" id={hintId}>{t('moveParentHint')}</span>
    </div>
  </form>
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" onclick={close}>{t('cancel')}</button>
    <button class="btn is-primary" type="submit" form={formId}>{t('moveParentSubmit')}</button>
  {/snippet}
</Dialog>
