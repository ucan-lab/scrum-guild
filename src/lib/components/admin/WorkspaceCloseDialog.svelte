<script lang="ts">
  import { workspaceClose } from '../../../shared/operations/workspace/index.ts';
  import { callOperation } from '../../api.ts';
  import { t } from '../../vocabulary.svelte.ts';
  import Dialog from '../Dialog.svelte';
  import Icon from '../Icon.svelte';

  // 閉じる前の確認（admin.html の「閉じる」）。読み取り専用になることと、開き直せることを伝える。
  // 開き直せる操作なので is-danger にせず、主ボタンを「閉じる」にする。
  // 送っている間は、「閉じる」を押しても無視し（aria-disabled）、ダイアログも閉じられない。二重送信はそれだけで防ぐ。
  // 結果は onfinish で親に渡し、トーストと一覧の読み直しは親が行う。送り始めた後に部品が外れた（画面を離れた、組織が替わった）ときは、
  // 古い応答を親に渡さず、状態も更新しない（generation）
  type Outcome = 'closed' | 'already_closed' | 'unauthenticated';
  let { slug, onfinish }: { slug: string; onfinish: (outcome: Outcome) => void } = $props();

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let target = $state<{ id: string; name: string } | null>(null);
  let submitting = $state(false);
  let submitError = $state<string | null>(null);
  let generation = 0;

  // 組織の枠のデータを読み直すと slug の props は新しい getter になるが、値が同じなら $derived は変わらない
  const currentSlug = $derived(slug);

  $effect(() => {
    void currentSlug;
    return () => {
      generation++;
      submitting = false;
      open = false;
    };
  });

  export function show(workspace: { id: string; name: string }, trigger?: HTMLElement | null): void {
    generation++;
    target = workspace;
    submitting = false;
    submitError = null;
    dialog?.show(trigger);
  }

  async function submit(): Promise<void> {
    if (target === null || submitting) return;
    const mine = generation;
    const targetSlug = slug;
    const workspaceId = target.id;
    submitting = true;
    submitError = null;
    try {
      const result = await callOperation(workspaceClose, { workspace_id: workspaceId }, { slug: targetSlug });
      if (mine !== generation) return;
      if (result.ok) {
        open = false;
        onfinish('closed');
      } else if (result.status === 401) {
        onfinish('unauthenticated');
      } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
        // 別の画面で先に閉じられていた。閉じた状態を読み直してもらう
        open = false;
        onfinish('already_closed');
      } else {
        submitError = t('workspaceCloseFailed', { workspace: t('workspace') });
      }
    } finally {
      if (mine === generation) submitting = false;
    }
  }

  // 状態を読み上げに伝える。領域は常に置き、中の文字だけを替える
  const status = $derived(submitting ? t('workspaceClosing') : '');
</script>

<Dialog
  bind:this={dialog}
  bind:open
  dismissible={!submitting}
  title={t('workspaceCloseTitle', { workspace: t('workspace') })}
>
  <p>{t('workspaceCloseText', { name: target?.name ?? '', task: t('task'), done: t('done') })}</p>
  {#if submitError !== null}
    <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{submitError}</span></div>
  {/if}
  <span class="visually-hidden" role="status">{status}</span>
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" aria-disabled={submitting} onclick={close}>{t('cancel')}</button>
    <!-- 右上の×（読み上げの名前は「閉じる」）と区別するため、どのワークスペースを閉じるかを名前に添える -->
    <button
      class="btn is-primary"
      type="button"
      aria-disabled={submitting}
      aria-label={submitting ? undefined : t('workspaceCloseLabel', { name: target?.name ?? '' })}
      onclick={submit}
    >
      {submitting ? t('workspaceClosing') : t('workspaceCloseAction')}
    </button>
  {/snippet}
</Dialog>
