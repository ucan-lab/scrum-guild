<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { epicRewardTiers, XP_EPIC_REWARD, type EpicRewardTier } from '../../shared/experience.ts';
  import { epicRewardUpdate } from '../../shared/operations/epic/index.ts';
  import { callOperation } from '../api.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import EpicTier from './EpicTier.svelte';
  import Icon from './Icon.svelte';

  // クリア報酬の段階を変えるダイアログ（エピックの画面の「<クリア報酬>を変える」。依頼主とリーダーだけに出る）。
  // 小、中、大を額つきのラジオで選ぶ（段階の印は EpicTier）。開いたときは、画面が渡す今の段階（tier）を選んでおく。
  // 今の段階のままなら「変える」は押せない（aria-disabled）。押すと epic-reward-update を送る。
  // 変えられたら閉じて、トーストで知らせ、onchanged で画面に読み直させる（別の画面で先に同じ段階になっていたときも、閉じてその旨を知らせる）。
  // 終わったエピック（409 の conflict）、権限が無い（403）、エピックが消えた（404）は理由を出し、閉じたときに画面を読み直す。
  // 閉じたワークスペース（409 の workspace_closed）は理由を出し、閉じたときに枠ごと読み直す。
  // 送っている間は「変える」を押しても無視し（aria-disabled）、ダイアログも閉じられない。
  // 送り始めた後に開き直した、部品が外れたときは、古い応答で状態を更新しない（generation）
  let {
    slug,
    workspaceId,
    epicId,
    tier,
    onchanged,
  }: {
    slug: string;
    workspaceId: string;
    epicId: string;
    tier: EpicRewardTier;
    onchanged: () => void;
  } = $props();

  const ids = $props.id();
  const formId = `${ids}-form`;
  const legendId = `${ids}-legend`;
  const hintId = `${ids}-hint`;
  const unchangedId = `${ids}-unchanged`;

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let submitButton = $state<HTMLButtonElement>();
  let choice = $state<EpicRewardTier>('small');
  let submitError = $state<string | null>(null);
  let submitting = $state(false);

  let generation = 0;
  // 閉じたワークスペースか、終わった、消えたエピックだと分かったら、ダイアログを閉じたときに画面を読み直す
  // （すぐに読み直すと、ダイアログごと外れて理由の文を読めなくなるため）
  let reloadOnClose: 'workspace' | 'epic' | null = null;
  $effect(() => {
    if (open || reloadOnClose === null) return;
    const target = reloadOnClose;
    reloadOnClose = null;
    if (target === 'workspace') void invalidateAll();
    else onchanged();
  });

  // ワークスペースかエピックが替わったら、開いたままにしない
  const currentKey = $derived(`${workspaceId}/${epicId}`);
  $effect(() => {
    void currentKey;
    return () => {
      generation++;
      submitting = false;
      open = false;
    };
  });

  export function show(trigger?: HTMLElement | null): void {
    generation++;
    reloadOnClose = null;
    choice = tier;
    submitError = null;
    submitting = false;
    dialog?.show(trigger);
  }

  const unchanged = $derived(choice === tier);

  function tierLabel(value: EpicRewardTier): string {
    return value === 'small' ? t('epicTierSmall') : value === 'medium' ? t('epicTierMedium') : t('epicTierLarge');
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting || unchanged) return;
    const mine = generation;
    const chosen = choice;
    submitting = true;
    submitError = null;
    // 欄が無効になる前にフォーカスを送信ボタンへ移し、Enter で送ったときにフォーカスが落ちないようにする
    submitButton?.focus();
    const words = {
      reward: t('reward'),
      party: t('party'),
      epic: t('epic'),
      workspace: t('workspace'),
      requester: t('requester'),
      leader: t('leader'),
      tier: tierLabel(chosen),
    };
    try {
      const result = await callOperation(
        epicRewardUpdate,
        { workspace_id: workspaceId, epic_id: epicId, reward_tier: chosen },
        { slug },
      );
      if (mine !== generation) return;
      if (result.ok) {
        // 前の失敗で閉じたときの読み直しを残していれば外す（onchanged を二重に呼ばない）
        reloadOnClose = null;
        open = false;
        showToast(t(result.data.changed ? 'epicRewardChanged' : 'epicRewardAlready', words), 'check');
        onchanged();
        return;
      }
      if (result.status === 401) {
        // セッションが切れた。枠の読み直しがログインの画面へ移す
        await invalidateAll();
        return;
      }
      if (result.error?.code === 'workspace_closed') {
        submitError = t('workspaceClosedReadOnly', words);
        reloadOnClose = 'workspace';
      } else if (result.status === 409) {
        submitError = t('epicRewardFinished', words);
        reloadOnClose = 'epic';
      } else if (result.status === 403) {
        submitError = t('epicRewardForbidden', words);
        reloadOnClose = 'epic';
      } else if (result.status === 404) {
        submitError = t('epicRewardGone', words);
        reloadOnClose = 'epic';
      } else {
        submitError = t('epicRewardFailed', words);
      }
    } finally {
      if (mine === generation) submitting = false;
    }
  }

  // 欄の説明は常に出し、今の段階のままのときだけ、押せない理由を別の文として足す
  const hint = $derived(t('epicPageRewardNote', { reward: t('reward'), party: t('party') }));
  // 常に置いた読み上げの領域の文字。送っている間だけ入れる（docs/design.md の「読み上げの領域は常に置き、文字だけを替える」）
  const status = $derived(submitting ? t('epicRewardSubmitting') : '');
</script>

<Dialog
  bind:this={dialog}
  bind:open
  dismissible={!submitting}
  title={t('epicPageChangeReward', { reward: t('reward') })}
>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    <fieldset class="form-fields" disabled={submitting}>
      <div class="field">
        <span class="field-label" id={legendId}>{t('epicRewardField', { reward: t('reward') })}</span>
        <div
          class="choice-list"
          role="radiogroup"
          aria-labelledby={legendId}
          aria-describedby={unchanged ? `${hintId} ${unchangedId}` : hintId}
        >
          {#each epicRewardTiers as value (value)}
            <label class="choice">
              <input type="radio" name="{ids}-tier" {value} bind:group={choice} />
              <div><EpicTier tier={value} xp={XP_EPIC_REWARD[value]} /></div>
            </label>
          {/each}
        </div>
        <span class="field-hint" id={hintId}>{hint}</span>
        {#if unchanged}<span class="field-hint" id={unchangedId}>{t('epicRewardUnchanged')}</span>{/if}
      </div>
    </fieldset>

    {#if submitError !== null}
      <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{submitError}</span></div>
    {/if}
  </form>
  <span class="visually-hidden" role="status">{status}</span>
  {#snippet footer(close)}
    <button class="btn is-quiet" type="button" aria-disabled={submitting} onclick={close}>{t('cancel')}</button>
    <button
      class="btn is-primary"
      type="submit"
      form={formId}
      aria-disabled={submitting || unchanged}
      bind:this={submitButton}
    >
      {submitting ? t('epicRewardSubmitting') : t('epicRewardSubmit')}
    </button>
  {/snippet}
</Dialog>
