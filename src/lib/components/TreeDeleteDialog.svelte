<script lang="ts">
  import { tick } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { DELETE_OTHERS_CHILDREN_REASON, type DeleteChildrenMode } from '../../shared/operations/delete-children.ts';
  import { epicDelete, epicGet } from '../../shared/operations/epic/index.ts';
  import { storyDelete, storyGet } from '../../shared/operations/story/index.ts';
  import { callOperation } from '../api.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // エピックとストーリーの削除の確認（design/kit.js の deleteEpic と deleteStory）。エピックとストーリーのダイアログの下の
  // 「この<エピック>を削除する」から、そのダイアログの上に開く。配下の件数と、配下の扱い（親なしで残す、まとめて削除する）を出し、
  // 既定は「残す」。配下が無ければ選ばせない（残すとして送る）。取り消せない操作なので is-danger にし、主ボタンは「削除する」。
  // 開いたら epic-get / story-get を読み直して、件数とまとめて削除できるかを今の値に差し替える（元のダイアログを開いてから
  // 配下が増えていても、古い件数で確かめさせない）。読んでいる間は主ボタンを押しても無視する（aria-disabled）。
  // 読めなければ、元のダイアログが読んだ値のまま出す（サーバーが今の配下で判定する）。
  // まとめて削除できない（リーダーと管理者でない人で、配下に他の人の作ったものがある）ときは、その選択肢を押せなくし、理由を添える。
  // 送っている間は、主ボタンを押しても無視し、ダイアログも閉じられない（OrganizationSuspendDialog と同じ）。
  // 結果は onfinish で親に渡す。削除できた（deleted）、無かった（gone。別の画面で先に削除された）は親が閉じて木を読み直す。
  // 権限が無い（403）、閉じたワークスペース（409）、通信や 5xx は、このダイアログの中の role="alert" に理由を出す。
  // 403 のうち、配下に他の人の作ったものが移されてきていた（details.reason が others_children）ときは、読み直して選択肢を押せなくする。
  // 閉じたワークスペースは、親が閉じたときに画面を読み直す（closed）
  type Outcome = 'deleted' | 'gone' | 'closed';
  type Target = {
    kind: 'epic' | 'story';
    id: string;
    title: string;
    // 配下の件数。エピックはストーリーとタスク（その下のもの）、ストーリーはタスク
    stories: number;
    tasks: number;
    // まとめて削除できるか
    canDeleteChildren: boolean;
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
  // 削除できるか。読み直しで偽になったら（リーダーから外されたなど）、主ボタンを押せなくする
  let canDelete = $state(true);
  // 読み直しで件数が変わったときに status へ出す文
  let announcement = $state('');
  let loading = $state(false);
  let submitting = $state(false);
  let submitError = $state<string | null>(null);
  let generation = 0;
  let cancelButton = $state<HTMLButtonElement>();

  const ids = $props.id();
  const legendId = `${ids}-children`;
  const leaderOnlyId = `${ids}-leader-only`;

  $effect(() => {
    return () => {
      generation++;
      submitting = false;
      open = false;
    };
  });

  // 件数とまとめて削除できるかを読み直す。読めなければ今の値のまま。消えていれば閉じて親に渡す
  async function refresh(current: Target, mine: number): Promise<void> {
    loading = true;
    try {
      const result =
        current.kind === 'epic'
          ? await callOperation(epicGet, { workspace_id: workspaceId, epic_id: current.id }, { slug })
          : await callOperation(storyGet, { workspace_id: workspaceId, story_id: current.id }, { slug });
      // 確認を閉じた後に届いた応答は捨てる（遅れた 404 で元のダイアログまで閉じない）
      if (mine !== generation || !open) return;
      if (result.ok) {
        const children = result.data.children;
        const before = target;
        target = {
          ...current,
          stories: 'stories' in children ? children.stories : 0,
          tasks: children.tasks,
          canDeleteChildren: result.data.can_delete_children,
        };
        if (!result.data.can_delete_children) mode = 'keep';
        // 件数が変わったら、取り消せない操作の中身が変わったことを読み上げにも伝える（変わった後の説明の文を status に出す）
        if (before !== null && (before.stories !== target.stories || before.tasks !== target.tasks)) {
          announcement = childrenText(target, mode);
        }
        canDelete = result.data.can_delete;
        const forbidden = t('taskDeleteForbidden', { leader: t('leader') });
        // 削除できるに戻ったら、前の読み直しで出した権限の文だけを消す（送った後の失敗の文は残す）
        if (!canDelete) submitError = forbidden;
        else if (submitError === forbidden) submitError = null;
        // 配下が無くなって選択肢が消えると、そこにあったフォーカスが body に落ちる。描き直した後にやめるボタンへ移す。
        // 読み終えた状態（主ボタンと status）は、描き直しを待たずに出す
        loading = false;
        await tick();
        if (
          mine === generation &&
          open &&
          (document.activeElement === null || document.activeElement === document.body)
        ) {
          cancelButton?.focus();
        }
      } else if (result.status === 401) {
        await invalidateAll();
      } else if (result.status === 404) {
        open = false;
        onfinish('gone');
      }
    } finally {
      if (mine === generation) loading = false;
    }
  }

  export function show(next: Target, trigger?: HTMLElement | null): void {
    generation++;
    target = next;
    mode = 'keep';
    canDelete = true;
    announcement = '';
    submitting = false;
    submitError = null;
    dialog?.show(trigger);
    void refresh(next, generation);
  }

  // 配下があるか。エピックはストーリーの数で決まる（タスクはストーリーの下にしかない）
  const hasChildren = $derived(target !== null && (target.kind === 'epic' ? target.stories > 0 : target.tasks > 0));

  async function send(current: Target, children: DeleteChildrenMode) {
    return current.kind === 'epic'
      ? await callOperation(epicDelete, { workspace_id: workspaceId, epic_id: current.id, children }, { slug })
      : await callOperation(storyDelete, { workspace_id: workspaceId, story_id: current.id, children }, { slug });
  }

  async function submit(): Promise<void> {
    if (target === null || submitting || loading || !canDelete) return;
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
      } else if (result.status === 403 && result.error?.code === 'forbidden') {
        const details = result.error.details as { reason?: unknown } | undefined;
        if (details?.reason === DELETE_OTHERS_CHILDREN_REASON) {
          submitError = t('treeDeleteAllLeaderOnly', { leader: t('leader') });
          void refresh(current, mine);
        } else {
          submitError = t('taskDeleteForbidden', { leader: t('leader') });
        }
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

  // 配下の扱いの説明。配下が無ければその旨、あれば選んでいる扱いの説明（画面に出す文と同じ）
  function childrenText(current: Target, children: DeleteChildrenMode): string {
    const values = { ...words, stories: current.stories, tasks: current.tasks };
    const empty = current.kind === 'epic' ? current.stories === 0 : current.tasks === 0;
    if (empty) {
      return current.kind === 'epic'
        ? t('epicDeleteNoChildren', { story: t('story') })
        : t('storyDeleteNoChildren', { task: t('task') });
    }
    if (current.kind === 'epic') {
      return children === 'keep' ? t('epicDeleteKeepHint', values) : t('epicDeleteAllHint', values);
    }
    return children === 'keep' ? t('storyDeleteKeepHint', values) : t('storyDeleteAllHint', values);
  }

  const status = $derived(submitting ? t('taskDeleting') : loading ? t('loading') : announcement);
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
      <div class="choice-list" role="radiogroup" aria-labelledby={legendId} aria-busy={loading}>
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
          <input
            type="radio"
            name="{ids}-children"
            value="delete"
            bind:group={mode}
            disabled={!target.canDeleteChildren}
            aria-describedby={target.canDeleteChildren ? undefined : leaderOnlyId}
          />
          <div>
            <b>{t('treeDeleteAll')}</b><span
              >{target.kind === 'epic'
                ? t('epicDeleteAllHint', { ...words, ...counts })
                : t('storyDeleteAllHint', { ...words, ...counts })}</span
            >
          </div>
        </label>
      </div>
      {#if !target.canDeleteChildren}
        <span class="field-hint" id={leaderOnlyId}>{t('treeDeleteAllLeaderOnly', { leader: t('leader') })}</span>
      {/if}
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
    <button class="btn is-quiet" type="button" aria-disabled={submitting} onclick={close} bind:this={cancelButton}
      >{t('taskDeleteCancel')}</button
    >
    <button class="btn is-danger" type="button" aria-disabled={submitting || loading || !canDelete} onclick={submit}>
      {submitting ? t('taskDeleting') : t('taskDeleteConfirm')}
    </button>
  {/snippet}
</Dialog>
