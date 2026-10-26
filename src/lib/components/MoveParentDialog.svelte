<script lang="ts" generics="T extends { id: string; title: string }">
  import { tick } from 'svelte';
  import { groupParents, type ParentOption } from '../parent-options.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';

  // 親を移すダイアログ。タスクの親（ストーリー）と、ストーリーの親（エピック）を移すときに使う。
  // 移す先は、親なしと、parents（画面が渡す、親にできる行。タスクなら完了していないストーリー、ストーリーなら完了も中止もしていない
  // エピック）のうち今の親でないもの。show(trigger, item, parentId) で、動かす行と今の親（null は親なし）を渡して開く。
  // 「移す」を押したら閉じて、onmove に動かす行と移す先を渡す。送るのと失敗の扱いは画面が持つ（並べ替えと同じく、先に画面を動かす）。
  // 移す先の末尾に置く（API には直前の行を送らない）
  let {
    parents,
    onmove,
  }: {
    parents: readonly ParentOption[];
    onmove: (item: T, parentId: string | null) => void;
  } = $props();

  const ids = $props.id();
  const formId = `${ids}-form`;
  const targetId = `${ids}-target`;
  const hintId = `${ids}-hint`;
  // 親なしの選択肢の値。親の ID とぶつからない
  const NONE = '';

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  // 動かす行。送ったら空にして、閉じるまでの2回目の送信を無視する。見出しの題は閉じるまで残す
  let item = $state<T | null>(null);
  let heading = $state('');
  let current = $state<string | null>(null);
  let choice = $state(NONE);

  const candidates = $derived(parents.filter((parent) => parent.id !== current));
  // ストーリーの候補は、親のエピックごとに optgroup でまとめる（エピックの候補は group を持たないので、まとめない）
  const candidateGroups = $derived(groupParents(candidates));

  export function show(trigger: HTMLElement | null, target: T, parentId: string | null): void {
    item = target;
    heading = target.title;
    current = parentId;
    // 今が親なしなら、最初の候補を選んでおく
    choice = parentId === null ? (candidates[0]?.id ?? NONE) : NONE;
    dialog?.show(trigger);
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (item === null) return;
    const moving = item;
    const parentId = choice === NONE ? null : choice;
    // 閉じるまでの間にもう一度送られても（Enter の連打など）、2回目は無視する
    item = null;
    open = false;
    // 今の親のままなら、何も送らずに閉じる
    if (parentId === current) return;
    // ダイアログが閉じて画面に戻ってから渡す（画面が、作り直した行へフォーカスを移せるように）
    await tick();
    onmove(moving, parentId);
  }
</script>

<Dialog bind:this={dialog} bind:open title={t('moveParentTitle', { title: heading })}>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    <div class="field">
      <label class="field-label" for={targetId}>{t('moveParentField')}</label>
      <select class="select" id={targetId} bind:value={choice} aria-describedby={hintId}>
        {#if current !== null}
          <option value={NONE}>{t('moveParentNone')}</option>
        {/if}
        {#each candidateGroups.groups as group, index (index)}
          {#if candidateGroups.grouped}
            <optgroup label={group.label ?? t('parentRootGroup', { story: t('story') })}>
              {#each group.options as option (option.id)}
                <option value={option.id}>{option.title}</option>
              {/each}
            </optgroup>
          {:else}
            {#each group.options as option (option.id)}
              <option value={option.id}>{option.title}</option>
            {/each}
          {/if}
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
