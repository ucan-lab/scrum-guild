<script lang="ts">
  import {
    ATTACHMENT_QUOTA_MAX_BYTES,
    MEMBER_LIMIT_MAX,
    organizationQuotaUpdate,
    QUOTA_GIB,
    quotaTiers,
  } from '../../shared/operations/operator/index.ts';
  import { callOperation } from '../api.ts';
  import { invalidateAll } from '$app/navigation';
  import { formatCount, quotaSize } from '../format.ts';
  import { isUnauthenticated } from '../login-redirect.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  // 組織の人数と添付ファイルの上限を変えるダイアログ（design/kit.js の changeQuota）。運用の画面だけが使う。
  // 値段の段階（quotaTiers）か「ほかの値」から選ぶ。今の上限に合う段階を選んだ状態で開き、どれにも合わなければ「ほかの値」を
  // 今の値（容量は GB の整数に丸め、1 GB 未満は 1）で埋めて開く。容量の欄は表示のための丸めなので、触っていなければ
  // 今のバイト数をそのまま送る（512 MB の組織の人数だけを変えても、容量は 512 MB のまま）。
  // ほかの値は 1 以上、上限以下の整数だけを送り、外れたら送る前に欄の下で断る。
  // 今と同じ値のままでは「変える」を押しても無視する（サーバーは何も書かずに今の値を返す）。
  // 開いたときの上限を expected に添えて送り、開いた後に別の運用者が変えていればサーバーが 409 で断る。
  // 選択肢を選び直したら、欄の誤りと送信の失敗の文を消す。
  // 書かれたか分からない失敗（5xx、通信の切れ）は、変わっていることもあると伝え、閉じたときに一覧を読み直す。
  // 添付ファイルの今の合計と、合計に関わる注意（合計が下がるまで添付できない、80% の通知）は #68 まで出さない。
  // 送っている間の扱いと、結果の渡し方（onfinish、generation）は OrganizationSuspendDialog と同じ
  type Outcome = 'done' | 'state_changed' | 'unavailable' | 'unauthenticated';
  type Choice = (typeof quotaTiers)[number]['id'] | 'other';
  type Current = { member_limit: number; attachment_quota_bytes: number; used: number };
  let { onfinish }: { onfinish: (outcome: Outcome) => void } = $props();

  let open = $state(false);
  let dialog = $state<ReturnType<typeof Dialog>>();
  let target = $state<{ slug: string; name: string; current: Current } | null>(null);
  let choice = $state<Choice>('small');
  let members = $state<number | null>(null);
  let sizeGb = $state<number | null>(null);
  // 容量の欄を触ったか。触っていなければ、丸めた欄の値でなく今のバイト数を使う
  let sizeTouched = $state(false);
  let errors = $state<{ members?: string; size?: string }>({});
  let submitting = $state(false);
  let submitError = $state<string | null>(null);
  // 書かれたか分からない失敗の後は、閉じたときに一覧を読み直す
  let reloadOnClose = false;
  let generation = 0;

  const ids = $props.id();
  const formId = `${ids}-form`;
  const choicesLabelId = `${ids}-choices`;
  const unchangedHintId = `${ids}-unchanged`;
  const fieldIds = { members: `${ids}-members`, size: `${ids}-size` } as const;
  const SIZE_MAX_GB = Math.floor(ATTACHMENT_QUOTA_MAX_BYTES / QUOTA_GIB);

  $effect(() => {
    return () => {
      generation++;
      submitting = false;
      open = false;
    };
  });

  $effect(() => {
    if (open || !reloadOnClose) return;
    reloadOnClose = false;
    void invalidateAll();
  });

  // 選択肢を選び直したら、前の誤りと失敗の文は今の選択に当たらないので消す
  function choose(): void {
    errors = {};
    submitError = null;
  }

  function sizeText(bytes: number): string {
    const quota = quotaSize(bytes);
    return t(quota.unit === 'gb' ? 'operatorQuotaSize' : 'operatorQuotaSizeMb', { size: quota.size });
  }

  const isWhole = (value: number | null, max: number): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max;

  export function show(
    organization: {
      slug: string;
      name: string;
      seats: { used: number; limit: number };
      attachment_quota_bytes: number;
    },
    trigger?: HTMLElement | null,
  ): void {
    generation++;
    const current = {
      member_limit: organization.seats.limit,
      attachment_quota_bytes: organization.attachment_quota_bytes,
      used: organization.seats.used,
    };
    target = { slug: organization.slug, name: organization.name, current };
    const tier = quotaTiers.find(
      (entry) =>
        entry.member_limit === current.member_limit && entry.attachment_quota_bytes === current.attachment_quota_bytes,
    );
    choice = tier?.id ?? 'other';
    members = current.member_limit;
    sizeGb = Math.max(1, Math.round(current.attachment_quota_bytes / QUOTA_GIB));
    sizeTouched = false;
    reloadOnClose = false;
    errors = {};
    submitting = false;
    submitError = null;
    dialog?.show(trigger);
  }

  // 選んだ上限。ほかの値の欄が範囲の外なら null
  const chosen = $derived.by(() => {
    const tier = quotaTiers.find((entry) => entry.id === choice);
    if (tier !== undefined)
      return { member_limit: tier.member_limit, attachment_quota_bytes: tier.attachment_quota_bytes };
    if (!isWhole(members, MEMBER_LIMIT_MAX)) return null;
    if (!sizeTouched && target !== null)
      return { member_limit: members, attachment_quota_bytes: target.current.attachment_quota_bytes };
    if (!isWhole(sizeGb, SIZE_MAX_GB)) return null;
    return { member_limit: members, attachment_quota_bytes: sizeGb * QUOTA_GIB };
  });
  const unchanged = $derived(
    target !== null &&
      chosen !== null &&
      chosen.member_limit === target.current.member_limit &&
      chosen.attachment_quota_bytes === target.current.attachment_quota_bytes,
  );

  function validate(): { members?: string; size?: string } {
    if (choice !== 'other') return {};
    const found: { members?: string; size?: string } = {};
    if (!isWhole(members, MEMBER_LIMIT_MAX))
      found.members = t('operatorQuotaMembersInvalid', { max: formatCount(MEMBER_LIMIT_MAX) });
    if (sizeTouched && !isWhole(sizeGb, SIZE_MAX_GB))
      found.size = t('operatorQuotaSizeInvalid', { max: formatCount(SIZE_MAX_GB) });
    return found;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (target === null || submitting) return;
    errors = validate();
    const firstInvalid = (['members', 'size'] as const).find((field) => errors[field] !== undefined);
    if (firstInvalid !== undefined) {
      document.getElementById(fieldIds[firstInvalid])?.focus();
      return;
    }
    if (chosen === null || unchanged) return;
    const mine = generation;
    submitting = true;
    submitError = null;
    try {
      const { current } = target;
      const result = await callOperation(organizationQuotaUpdate, {
        slug: target.slug,
        ...chosen,
        expected: { member_limit: current.member_limit, attachment_quota_bytes: current.attachment_quota_bytes },
      });
      if (mine !== generation) return;
      if (result.ok) {
        open = false;
        onfinish('done');
      } else if (isUnauthenticated(result)) {
        onfinish('unauthenticated');
      } else if (result.status === 409 && result.error?.code === 'conflict') {
        // 別の画面で先に変えられていた。読み直した一覧を見てもらう
        open = false;
        onfinish('state_changed');
      } else if (result.status === 404 || result.status === 403) {
        open = false;
        onfinish('unavailable');
      } else if (result.status === 0 || result.status >= 500) {
        // 書けた後に応答だけが失われたこともある。閉じたら一覧を読み直す
        submitError = t('operatorQuotaFailedUnknown');
        reloadOnClose = true;
      } else {
        submitError = t('operatorQuotaFailed');
      }
    } finally {
      if (mine === generation) submitting = false;
    }
  }

  const status = $derived(submitting ? t('operatorChanging') : '');
  const text = $derived(
    target === null
      ? ''
      : t('operatorQuotaText', {
          name: target.name,
          used: target.current.used,
          limit: target.current.member_limit,
          quota: sizeText(target.current.attachment_quota_bytes),
        }),
  );
  const tierNames = $derived({
    small: t('operatorQuotaTierSmall', { organization: t('organization') }),
    standard: t('operatorQuotaTierStandard'),
  });
</script>

{#snippet error(field: 'members' | 'size')}
  {#if errors[field] !== undefined}
    <span class="field-error" id="{fieldIds[field]}-error" role="alert"><Icon name="alert" />{errors[field]}</span>
  {/if}
{/snippet}

<Dialog bind:this={dialog} bind:open dismissible={!submitting} title={t('operatorQuotaTitle')}>
  <form id={formId} class="form" onsubmit={submit} novalidate>
    <!-- 組織の名前は自由に付けられるので、長い名前や区切りのない名前でも折り返す -->
    <p class="wrap-anywhere">{text}</p>
    <div class="form-fields">
      <div class="field">
        <span class="field-label" id={choicesLabelId}>{t('operatorQuotaChoices')}</span>
        <div class="choice-list" role="radiogroup" aria-labelledby={choicesLabelId}>
          {#each quotaTiers as tier (tier.id)}
            <label class="choice">
              <input type="radio" name="{ids}-tier" value={tier.id} bind:group={choice} onchange={choose} />
              <div>
                <b>{tierNames[tier.id]}</b><span
                  >{t('operatorQuotaTierValue', {
                    members: tier.member_limit,
                    quota: sizeText(tier.attachment_quota_bytes),
                  })}</span
                >
              </div>
            </label>
          {/each}
          <label class="choice">
            <input type="radio" name="{ids}-tier" value="other" bind:group={choice} onchange={choose} />
            <div>
              <b>{t('operatorQuotaTierOther')}</b><span
                >{t('operatorQuotaTierOtherHint', { organization: t('organization') })}</span
              >
            </div>
          </label>
        </div>
      </div>
      {#if choice === 'other'}
        <div class="form-row is-start">
          <div class="field" class:is-invalid={errors.members !== undefined}>
            <label class="field-label" for={fieldIds.members}>{t('operatorQuotaMembersLabel')}</label>
            <input
              class="input"
              id={fieldIds.members}
              type="number"
              inputmode="numeric"
              min="1"
              max={MEMBER_LIMIT_MAX}
              step="1"
              bind:value={members}
              oninput={() => (errors.members = undefined)}
              aria-invalid={errors.members !== undefined}
              aria-describedby={errors.members !== undefined ? `${fieldIds.members}-error` : undefined}
            />
            {@render error('members')}
          </div>
          <div class="field" class:is-invalid={errors.size !== undefined}>
            <label class="field-label" for={fieldIds.size}>{t('operatorQuotaSizeLabel')}</label>
            <input
              class="input"
              id={fieldIds.size}
              type="number"
              inputmode="numeric"
              min="1"
              max={SIZE_MAX_GB}
              step="1"
              bind:value={sizeGb}
              oninput={() => {
                sizeTouched = true;
                errors.size = undefined;
              }}
              aria-invalid={errors.size !== undefined}
              aria-describedby={errors.size !== undefined ? `${fieldIds.size}-error` : undefined}
            />
            {@render error('size')}
          </div>
        </div>
      {/if}
      {#if unchanged}
        <span class="field-hint" id={unchangedHintId}>{t('operatorQuotaUnchangedHint')}</span>
      {/if}
      <p class="field-hint">{t('operatorQuotaNote')}</p>
      <p class="field-hint">{t('operatorQuotaHistoryNote', { organization: t('organization') })}</p>
    </div>
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
      aria-describedby={unchanged ? unchangedHintId : undefined}
    >
      {submitting ? t('operatorChanging') : t('operatorChangeSubmit')}
    </button>
  {/snippet}
</Dialog>
