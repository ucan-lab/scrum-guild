<script lang="ts">
  import { tick } from 'svelte';
  import { page } from '$app/state';
  import {
    HOLIDAY_NAME_MAX_LENGTH,
    HOLIDAYS_PER_REQUEST,
    parseHolidayPaste,
    type HolidayLineProblem,
  } from '../../../shared/holiday.ts';
  import {
    organizationHolidayAdd,
    organizationHolidayDelete,
    organizationHolidayList,
  } from '../../../shared/operations/organization/index.ts';
  import type { OutputOf } from '../../../shared/operations/define.ts';
  import { callOperation } from '../../api.ts';
  import { isUnauthenticated, loginUrl } from '../../login-redirect.ts';
  import { showToast } from '../../toast.svelte.ts';
  import { t } from '../../vocabulary.svelte.ts';
  import EmptyState from '../EmptyState.svelte';
  import Icon from '../Icon.svelte';
  import Setting from '../Setting.svelte';
  import SectionBoundary from './SectionBoundary.svelte';
  import { SectionLoad } from './section-load.svelte.ts';

  // 組織の管理の画面（admin.html）の組織の休日の節。読み込みの状態は SectionLoad、その表示は SectionBoundary に任せる。
  // 貼り付けた文字は src/shared/holiday.ts の parseHolidayPaste で行ごとに読み、正しい行だけを送る（API も同じ決まりで検証し直す）。
  // 形の合わない行は「登録する」を押した後に、行の番号と理由を欄の下に出す。送れたら、欄には直す行（重なった日付の行は除く）だけを残す。
  // 正しい行が上限を超えたら送らず、分けるよう示す。削除は確かめのダイアログを挟まない（入れ直せるため）。
  // 送っている間は、「登録する」とどの行の削除も aria-disabled にして押しても無視する。登録と削除の後は一覧を読み直す
  let { slug }: { slug: string } = $props();

  type Holiday = OutputOf<typeof organizationHolidayList>['holidays'][number];

  const currentSlug = $derived(slug);
  const ids = $props.id();
  const pasteId = `${ids}-paste`;
  const hintId = `${ids}-hint`;
  const errorId = `${ids}-error`;

  let holidays = $state<Holiday[]>([]);
  let text = $state('');
  // 「登録する」を押した後だけ、行ごとの理由を出す（打っている途中の行に理由を出さない）
  let attempted = $state(false);
  // 行ではなく送信の全体に掛かる誤り（登録できる行が無い、上限を超えた、送れなかった）
  let submitError = $state<string | null>(null);
  let busy = $state<'adding' | 'deleting' | null>(null);
  let list = $state<HTMLUListElement>();
  let pasteInput = $state<HTMLTextAreaElement>();

  const parsed = $derived(parseHolidayPaste(text));
  const problems = $derived(attempted ? parsed.problems : []);
  const invalid = $derived(problems.length > 0 || submitError !== null);

  const section = new SectionLoad(
    () => callOperation(organizationHolidayList, {}, { slug: currentSlug }),
    (data) => {
      holidays = data.holidays;
    },
  );

  // slug が替わったら、前の組織の一覧と入力を捨てて読み直す
  section.attach(
    () => currentSlug,
    () => {
      holidays = [];
      text = '';
      attempted = false;
      submitError = null;
      busy = null;
    },
  );

  function reasonText(reason: HolidayLineProblem): string {
    switch (reason) {
      case 'invalid_date':
        return t('holidayProblemInvalidDate');
      case 'no_such_date':
        return t('holidayProblemNoSuchDate');
      case 'too_long':
        return t('holidayProblemTooLong', { max: HOLIDAY_NAME_MAX_LENGTH });
      case 'invalid_character':
        return t('holidayProblemInvalidCharacter');
      case 'duplicate':
        return t('holidayProblemDuplicate');
    }
  }

  function edited(): void {
    submitError = null;
    if (text.trim() === '') attempted = false;
  }

  // 送れた後に欄へ残す行。直せば登録できる行だけで、重なった日付の行（前の行の日付を登録した）は落とす
  function remainingText(): string {
    return parsed.problems
      .filter((problem) => problem.reason !== 'duplicate')
      .map((problem) => problem.text)
      .join('\n');
  }

  async function submit(): Promise<void> {
    if (busy !== null) return;
    attempted = true;
    submitError = null;
    const toSend = parsed.holidays;
    if (toSend.length === 0) {
      if (parsed.problems.length === 0) submitError = t('holidayNothingToAdd');
      return;
    }
    if (toSend.length > HOLIDAYS_PER_REQUEST) {
      submitError = t('holidayTooMany', { count: toSend.length, max: HOLIDAYS_PER_REQUEST });
      return;
    }
    const token = section.token();
    busy = 'adding';
    try {
      const result = await callOperation(organizationHolidayAdd, { holidays: toSend }, { slug: currentSlug });
      if (!section.isCurrent(token)) return;
      if (result.ok) {
        const { added, skipped } = result.data;
        showToast(
          skipped === 0 ? t('holidayAdded', { added }) : t('holidayAddedWithSkipped', { added, skipped }),
          'check',
        );
        text = remainingText();
        if (text === '') attempted = false;
        await section.load();
      } else if (isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
      } else if (result.status === 400) {
        submitError = t('holidayAddRejected');
      } else {
        submitError = t('holidayAddFailed');
      }
    } finally {
      if (section.isCurrent(token)) busy = null;
    }
  }

  async function remove(holiday: Holiday, index: number): Promise<void> {
    if (busy !== null) return;
    const token = section.token();
    busy = 'deleting';
    try {
      const result = await callOperation(
        organizationHolidayDelete,
        { holiday_on: holiday.holiday_on },
        { slug: currentSlug },
      );
      if (!section.isCurrent(token)) return;
      if (isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      if (result.ok) showToast(t('holidayDeleted', { date: holiday.holiday_on }), 'check');
      else if (result.status === 404) showToast(t('holidayAlreadyDeleted', { date: holiday.holiday_on }), 'alert');
      else showToast(t('holidayDeleteFailed', { date: holiday.holiday_on }), 'alert');
      await section.load();
      if (!section.isCurrent(token)) return;
      // 押したボタンは行ごと消えるので、同じ位置の行（無ければ前の行）の削除ボタンへ、一覧が空なら貼り付けの欄へフォーカスを移す
      await tick();
      const buttons = list?.querySelectorAll<HTMLButtonElement>('button') ?? [];
      const next = buttons[Math.min(index, buttons.length - 1)];
      (next ?? pasteInput)?.focus();
    } finally {
      if (section.isCurrent(token)) busy = null;
    }
  }

  const status = $derived(busy === 'adding' ? t('holidaySubmitting') : busy === 'deleting' ? t('holidayDeleting') : '');
</script>

<Setting title={t('holidaysTitle')} description={t('holidaysDesc', { workspace: t('workspace') })}>
  <div class="field" class:is-invalid={invalid}>
    <label class="field-label" for={pasteId}>{t('holidayPasteLabel')}</label>
    <textarea
      class="textarea"
      id={pasteId}
      bind:this={pasteInput}
      bind:value={text}
      oninput={edited}
      placeholder={t('holidayPastePlaceholder')}
      aria-invalid={invalid}
      aria-describedby={invalid ? `${errorId} ${hintId}` : hintId}></textarea>
    <!-- 誤りの領域は常に置き、中身だけを替える（送った後に出た理由を読み上げに伝える） -->
    <div id={errorId} role="alert">
      {#if submitError !== null}
        <span class="field-error"><Icon name="alert" />{submitError}</span>
      {/if}
      {#if problems.length > 0}
        <span class="field-error"><Icon name="alert" />{t('holidayProblemsNote')}</span>
        <ul class="field-error-list" aria-label={t('holidayProblemsLabel')}>
          {#each problems as problem (problem.line)}
            <li>
              {t('holidayProblemLine', { line: problem.line, text: problem.text, reason: reasonText(problem.reason) })}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    <span class="field-hint" id={hintId}>{t('holidayPasteHint')}</span>
  </div>
  <div class="form-actions">
    <button class="btn" type="button" aria-disabled={busy !== null} onclick={submit}>
      {busy === 'adding' ? t('holidaySubmitting') : t('holidaySubmit')}
    </button>
  </div>

  <SectionBoundary {section} failedTitle={t('holidayListLoadFailed')} refreshFailedText={t('holidayListRefreshFailed')}>
    {#if holidays.length === 0}
      <EmptyState
        icon="calendar"
        title={t('holidayEmptyTitle')}
        text={t('holidayEmptyText', { capacity: t('capacity') })}
      />
    {:else}
      <ul class="party-list" aria-label={t('holidayListLabel')} bind:this={list}>
        {#each holidays as holiday, index (holiday.holiday_on)}
          <li>
            <span class="mono">{holiday.holiday_on}</span>
            {#if holiday.name !== null}<span class="party-list-text">{holiday.name}</span>{/if}
            <button
              class="icon-btn is-danger party-list-end"
              type="button"
              aria-disabled={busy !== null}
              aria-label={t('holidayDeleteLabel', { date: holiday.holiday_on })}
              onclick={() => remove(holiday, index)}
            >
              <Icon name="trash" />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </SectionBoundary>
  <!-- 送っている間の読み上げ。領域は常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{status}</span>
</Setting>
