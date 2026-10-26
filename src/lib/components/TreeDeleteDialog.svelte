<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import type { DeleteChildrenMode } from '../../shared/operations/delete-children.ts';
  import { epicDelete } from '../../shared/operations/epic/index.ts';
  import { storyDelete } from '../../shared/operations/story/index.ts';
  import { callOperation } from '../api.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // エピックとストーリーの削除の確認（design/kit.js の deleteEpic と deleteStory）。エピックとストーリーのダイアログの下の
  // 「この<エピック>を削除する」から、そのダイアログの上に開く。配下の件数と、配下の扱い（親なしで残す、まとめて削除する）を出し、
  // 既定は「残す」。配下が無ければ選ばせない（残すとして送る）。取り消せない操作なので is-danger にし、主ボタンは「削除する」。
  // 送っている間は、主ボタンを押しても無視し（aria-disabled）、ダイアログも閉じられない（OrganizationSuspendDialog と同じ）。
  // 結果は onfinish で親に渡す。削除できた（deleted）、無かった（gone。別の画面で先に削除された）は親が閉じて木を読み直す。
  // 権限が無い（403）、閉じたワークスペース（409）、通信や 5xx は、このダイアログの中の role="alert" に理由を出す。
  // 閉じたワークスペースは、親が閉じたときに画面を読み直す（closed）
  type Outcome = 'deleted' | 'gone' | 'closed';
  type Target = {
    kind: 'epic' | 'story';
    id: string;
    title: string;
    // 配下の件数。エピックはストーリーとタスク（その下のもの）、ストーリーはタスク
    stories: number;
    tasks: number;
  };
  let {
    slug,
    workspaceId,
    onfinish,
  }: {
    slug: string;
    workspaceId: string;
    onfinish: (outcome: Outcome) => void;
  } = $props();

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let target = $state<Target | null>(null);
  let mode = $state<DeleteChildrenMode>('keep');
  let submitting = $state(false);
  let submitError = $state<string | null>(null);
  let generation = 0;

  const ids = $props.id();
  const legendId = `${ids}-children`;

  $effect(() => {
    return () => {
      generation++;
      submitting = false;
      open = false;
    };
  });

  export function show(next: Target, trigger?: HTMLElement | null): void {
    generation++;
    target = next;
    mode = 'keep';
    submitting = false;
    submitError = null;
    dialog?.show(trigger);
  }

  // 配下があるか。エピックはストーリーの数で決まる（タスクはストーリーの下にしかない）
  const hasChildren = $derived(target !== null && (target.kind === 'epic' ? target.stories > 0 : target.tasks > 0));

  async function send(current: Target, children: DeleteChildrenMode) {
    return current.kind === 'epic'
      ? await callOperation(epicDelete, { workspace_id: workspaceId, epic_id: current.id, children }, { slug })
      : await callOperation(storyDelete, { workspace_id: workspaceId, story_id: current.id, children }, { slug });
  }

  async function submit(): Promise<void> {
    if (target === null || submitting) return;
    const current = target;
    const mine = generation;
    submitting = true;
    submitError = null;
    try {
      const result = await send(current, hasChildren ? mode : 'keep');
      if (mine !== generation) return;
      if (result.ok) {
        open = false;
        onfinish('deleted');
      } else if (result.status === 401) {
        await invalidateAll();
      } else if (result.status === 404) {
        open = false;
        onfinish('gone');
      } else if (result.status === 403) {
        submitError = t('taskDeleteForbidden', { leader: t('leader') });
      } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
        submitError = t('workspaceClosedReadOnly', { workspace: t('workspace') });
        onfinish('closed');
      } else {
        submitError = t('taskDeleteFailed');
      }
    } finally {
      if (mine === generation) submitting = false;
    }
  }

  const status = $derived(submitting ? t('taskDeleting') : '');
  const counts = $derived({ stories: target?.stories ?? 0, tasks: target?.tasks ?? 0 });
  const words = $derived({
    epic: t('epic'),
    story: t('story'),
    task: t('task'),
    category: t('category'),
    archive: t('archive'),
  });
</script>

<Dialog
  bind:this={dialog}
  bind:open
  danger
  dismissible={!submitting}
  title={target?.kind === 'story'
    ? t('storyDeleteTitle', { story: t('story') })
    : t('epicDeleteTitle', { epic: t('epic') })}
>
  <!-- タイトルは自由に付けられるので、長いタイトルや区切りのないタイトルでも折り返す -->
  <p class="wrap-anywhere">{t('taskDeleteText', { title: target?.title ?? '' })}</p>
  {#if target !== null && hasChildren}
    <div class="field">
      <span class="field-label" id={legendId}>{t('treeDeleteChildren')}</span>
      <div class="choice-list" role="radiogroup" aria-labelledby={legendId}>
        <label class="choice">
          <input type="radio" name="{ids}-children" value="keep" bind:group={mode} />
          <div>
            <b>{t('treeDeleteKeep')}</b><span
              >{target.kind === 'epic'
                ? t('epicDeleteKeepHint', { ...words, ...counts })
                : t('storyDeleteKeepHint', { ...words, ...counts })}</span
            >
          </div>
        </label>
        <label class="choice">
          <input type="radio" name="{ids}-children" value="delete" bind:group={mode} />
          <div>
            <b>{t('treeDeleteAll')}</b><span
              >{target.kind === 'epic'
                ? t('epicDeleteAllHint', { ...words, ...counts })
                : t('storyDeleteAllHint', { ...words, ...counts })}</span
            >
          </div>
        </label>
      </div>
    </div>
  {:else if target !== null}
    <p class="field-hint">
      {target.kind === 'epic'
        ? t('epicDeleteNoChildren', { story: t('story') })
        : t('storyDeleteNoChildren', { task: t('task') })}
    </p>
  {/if}
  <p class="field-hint">{t('taskDeleteHint')}</p>
  {#if submitError !== null}
    <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{submitError}</span></div>
  {/if}
  <span class="visually-hidden" role="status">{status}</span>
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" aria-disabled={submitting} onclick={close}
      >{t('taskDeleteCancel')}</button
    >
    <button class="btn is-danger" type="button" aria-disabled={submitting} onclick={submit}>
      {submitting ? t('taskDeleting') : t('taskDeleteConfirm')}
    </button>
  {/snippet}
</Dialog>
