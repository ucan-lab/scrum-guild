<script lang="ts">
  import { organizationSuspend, type SuspensionKind } from '../../shared/operations/operator/index.ts';
  import { callOperation } from '../api.ts';
  import { isUnauthenticated } from '../login-redirect.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // 組織を停止する前の確認（design/kit.js の suspendOrganization）。誰も入れなくなるので is-danger にし、
  // 停止の理由（一時的な停止か、解約か）を選ばせる。再開は確認を挟まないので、このダイアログは停止だけを受け持つ。
  // 送っている間は、「停止する」を押しても無視し（aria-disabled）、ダイアログも閉じられない。二重送信はそれだけで防ぐ。
  // 結果は onfinish で親に渡し、トーストと一覧の読み直しは親が行う。送り始めた後に部品が外れたときは、
  // 古い応答を親に渡さず、状態も更新しない（generation）
  type Outcome = 'suspended' | 'state_changed' | 'unavailable' | 'unauthenticated';
  let { onfinish }: { onfinish: (outcome: Outcome) => void } = $props();

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let target = $state<{ slug: string; name: string } | null>(null);
  let kind = $state<SuspensionKind>('temporary');
  let submitting = $state(false);
  let submitError = $state<string | null>(null);
  let generation = 0;

  const ids = $props.id();
  const reasonLabelId = `${ids}-reason`;

  $effect(() => {
    return () => {
      generation++;
      submitting = false;
      open = false;
    };
  });

  export function show(organization: { slug: string; name: string }, trigger?: HTMLElement | null): void {
    generation++;
    target = organization;
    kind = 'temporary';
    submitting = false;
    submitError = null;
    dialog?.show(trigger);
  }

  async function submit(): Promise<void> {
    if (target === null || submitting) return;
    const mine = generation;
    const { slug } = target;
    submitting = true;
    submitError = null;
    try {
      const result = await callOperation(organizationSuspend, { slug, kind });
      if (mine !== generation) return;
      if (result.ok) {
        open = false;
        onfinish('suspended');
      } else if (isUnauthenticated(result)) {
        onfinish('unauthenticated');
      } else if (result.status === 409 && result.error?.code === 'conflict') {
        // 別の画面で先に停止されていた。読み直した一覧を見てもらう
        open = false;
        onfinish('state_changed');
      } else if (result.status === 404 || result.status === 403) {
        // 見つからない、または操作できない。もう一度試しても直らないので、理由を知らせて閉じ、一覧を読み直してもらう
        open = false;
        onfinish('unavailable');
      } else {
        submitError = t('operatorSuspendFailed', { organization: t('organization') });
      }
    } finally {
      if (mine === generation) submitting = false;
    }
  }

  // 状態を読み上げに伝える。領域は常に置き、中の文字だけを替える
  const status = $derived(submitting ? t('operatorSuspending') : '');
</script>

<Dialog
  bind:this={dialog}
  bind:open
  danger
  dismissible={!submitting}
  title={t('operatorSuspendTitle', { organization: t('organization') })}
>
  <p>{t('operatorSuspendText', { name: target?.name ?? '' })}</p>
  <div class="field">
    <span class="field-label" id={reasonLabelId}>{t('operatorSuspendReason')}</span>
    <div class="choice-list" role="radiogroup" aria-labelledby={reasonLabelId}>
      <label class="choice">
        <input type="radio" name="{ids}-kind" value="temporary" bind:group={kind} />
        <div><b>{t('operatorSuspendTemporary')}</b><span>{t('operatorSuspendTemporaryHint')}</span></div>
      </label>
      <label class="choice">
        <input type="radio" name="{ids}-kind" value="cancellation" bind:group={kind} />
        <div><b>{t('operatorSuspendCancellation')}</b><span>{t('operatorSuspendCancellationHint')}</span></div>
      </label>
    </div>
  </div>
  {#if submitError !== null}
    <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{submitError}</span></div>
  {/if}
  <span class="visually-hidden" role="status">{status}</span>
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" aria-disabled={submitting} onclick={close}>{t('cancel')}</button>
    <!-- 右上の×（読み上げの名前は「閉じる」）と区別するため、どの組織を停止するかを名前に添える -->
    <button
      class="btn is-danger"
      type="button"
      aria-disabled={submitting}
      aria-label={submitting ? undefined : t('operatorSuspendLabel', { name: target?.name ?? '' })}
      onclick={submit}
    >
      {submitting ? t('operatorSuspending') : t('operatorSuspendAction')}
    </button>
  {/snippet}
</Dialog>
