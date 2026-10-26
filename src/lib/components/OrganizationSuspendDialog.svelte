<script lang="ts">
  import {
    organizationSuspend,
    organizationSuspensionUpdate,
    PURGE_AFTER_DAYS,
    type SuspensionKind,
  } from '../../shared/operations/operator/index.ts';
  import { callOperation } from '../api.ts';
  import { isUnauthenticated } from '../login-redirect.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // 組織の停止の確認と、停止中の組織の停止の理由の切り替え。
  // 停止する前の確認（design/kit.js の suspendOrganization）は、誰も入れなくなるので is-danger にし、停止の理由
  // （一時的な停止か、解約）を選ばせる。停止の理由を変えるダイアログ（design/kit.js の changeSuspension）は、同じ選び方で、
  // 今の理由を選んだ状態で開く。今と同じ理由では送れない（サーバーは 409）。再開は確認を挟まないので、このダイアログの外で行う。
  // 送っている間は、主ボタンを押しても無視し（aria-disabled）、ダイアログも閉じられない。二重送信はそれだけで防ぐ。
  // 結果は onfinish で親に渡し、トーストと一覧の読み直しは親が行う。送り始めた後に部品が外れたときは、
  // 古い応答を親に渡さず、状態も更新しない（generation）
  type Outcome = 'done' | 'state_changed' | 'unavailable' | 'unauthenticated';
  let { onfinish }: { onfinish: (outcome: Outcome) => void } = $props();

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  // currentKind があれば停止の理由を変えるダイアログ。停止する前の確認では undefined
  let target = $state<{ slug: string; name: string; currentKind?: SuspensionKind } | null>(null);
  let kind = $state<SuspensionKind>('temporary');
  let submitting = $state(false);
  let submitError = $state<string | null>(null);
  let generation = 0;

  const ids = $props.id();
  const reasonLabelId = `${ids}-reason`;
  const unchangedHintId = `${ids}-unchanged`;
  const changing = $derived(target?.currentKind !== undefined);
  const unchanged = $derived(changing && kind === target?.currentKind);
  const days = String(PURGE_AFTER_DAYS);

  $effect(() => {
    return () => {
      generation++;
      submitting = false;
      open = false;
    };
  });

  export function show(
    organization: { slug: string; name: string; currentKind?: SuspensionKind },
    trigger?: HTMLElement | null,
  ): void {
    generation++;
    target = organization;
    kind = organization.currentKind ?? 'temporary';
    submitting = false;
    submitError = null;
    dialog?.show(trigger);
  }

  async function send(slug: string) {
    return changing
      ? await callOperation(organizationSuspensionUpdate, { slug, kind })
      : await callOperation(organizationSuspend, { slug, kind });
  }

  async function submit(): Promise<void> {
    if (target === null || submitting || unchanged) return;
    const mine = generation;
    submitting = true;
    submitError = null;
    try {
      const result = await send(target.slug);
      if (mine !== generation) return;
      if (result.ok) {
        open = false;
        onfinish('done');
      } else if (isUnauthenticated(result)) {
        onfinish('unauthenticated');
      } else if (result.status === 409 && result.error?.code === 'conflict') {
        // 別の画面で先に操作されていた。読み直した一覧を見てもらう
        open = false;
        onfinish('state_changed');
      } else if (result.status === 404 || result.status === 403) {
        // 見つからない、または操作できない。もう一度試しても直らないので、理由を知らせて閉じ、一覧を読み直してもらう
        open = false;
        onfinish('unavailable');
      } else {
        submitError = changing
          ? t('operatorChangeFailed')
          : t('operatorSuspendFailed', { organization: t('organization') });
      }
    } finally {
      if (mine === generation) submitting = false;
    }
  }

  // 状態を読み上げに伝える。領域は常に置き、中の文字だけを替える
  const status = $derived(submitting ? (changing ? t('operatorChanging') : t('operatorSuspending')) : '');
  const name = $derived(target?.name ?? '');
</script>

<Dialog
  bind:this={dialog}
  bind:open
  danger={!changing}
  dismissible={!submitting}
  title={changing ? t('operatorChangeTitle') : t('operatorSuspendTitle', { organization: t('organization') })}
>
  <!-- 組織の名前は自由に付けられるので、長い名前や区切りのない名前でも折り返す -->
  <p class="wrap-anywhere">{changing ? t('operatorChangeText', { name }) : t('operatorSuspendText', { name })}</p>
  <div class="field">
    <span class="field-label" id={reasonLabelId}>{t('operatorSuspendReason')}</span>
    <div class="choice-list" role="radiogroup" aria-labelledby={reasonLabelId}>
      <label class="choice">
        <input type="radio" name="{ids}-kind" value="temporary" bind:group={kind} />
        <div>
          <b>{t('operatorSuspendTemporary')}</b><span
            >{changing ? t('operatorChangeTemporaryHint') : t('operatorSuspendTemporaryHint')}</span
          >
        </div>
      </label>
      <label class="choice">
        <input type="radio" name="{ids}-kind" value="cancellation" bind:group={kind} />
        <div>
          <b>{t('operatorSuspendCancellation')}</b><span
            >{changing
              ? t('operatorChangeCancellationHint', { days })
              : t('operatorSuspendCancellationHint', { days })}</span
          >
        </div>
      </label>
    </div>
    {#if unchanged}
      <span class="field-hint" id={unchangedHintId}>{t('operatorChangeUnchangedHint')}</span>
    {/if}
  </div>
  {#if submitError !== null}
    <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{submitError}</span></div>
  {/if}
  <span class="visually-hidden" role="status">{status}</span>
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" aria-disabled={submitting} onclick={close}>{t('cancel')}</button>
    {#if changing}
      <button
        class="btn is-primary"
        type="button"
        aria-disabled={submitting || unchanged}
        aria-describedby={unchanged ? unchangedHintId : undefined}
        onclick={submit}
      >
        {submitting ? t('operatorChanging') : t('operatorChangeSubmit')}
      </button>
    {:else}
      <!-- 右上の×（読み上げの名前は「閉じる」）と区別するため、どの組織を停止するかを名前に添える -->
      <button
        class="btn is-danger"
        type="button"
        aria-disabled={submitting}
        aria-label={submitting ? undefined : t('operatorSuspendLabel', { name })}
        onclick={submit}
      >
        {submitting ? t('operatorSuspending') : t('operatorSuspendAction')}
      </button>
    {/if}
  {/snippet}
</Dialog>
