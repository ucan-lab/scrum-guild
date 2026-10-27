<script lang="ts">
  import { untrack } from 'svelte';
  import {
    FILTER_ME,
    FILTER_NONE,
    emptyFilter,
    isFiltering,
    sameFilter,
    type BacklogFilter,
    type FilterSelectKey,
  } from '../backlog-filter.ts';
  import {
    BACKLOG_QUERY_MAX_LENGTH,
    BACKLOG_QUERY_MAX_WORDS,
    backlogQueryProblem,
    searchWordsOf,
  } from '../../shared/backlog-filter.ts';
  import type { BacklogChoices } from '../../shared/operations/task/backlog-tree.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Icon from './Icon.svelte';

  // バックログの絞り込みの帯（見本の design/backlog.html の .toolbar。role="search"）。検索の欄と、担当、区分、リポジトリ、エピックの
  // 選択欄（1つだけ選ぶ select。先頭が「すべて」、末尾が「なし」。担当は先頭に「自分」、離脱した人には「（離脱済み）」を添える）。
  // filter は木を読んだときの絞り込み（URL の問い合わせ）。値を変えると onchange に次の絞り込みを渡し、画面が URL を書き換えて木を読み直す。
  // 選択欄はすぐ、検索は入力が 300ms 止まってから（Enter ならすぐ）渡す。検索が上限を超えていれば、帯の下に理由を出して渡さない。
  // 絞り込みが1つでも掛かっていれば、帯の端に「絞り込みを外す」を出す。
  // URL の値が選択肢に無い（消えた区分、別のワークスペースの値）ときは、その値を「一覧に無い値」の選択肢で残す。
  // 区分とリポジトリの一覧（categories、repositories）が読めなければ（definitionsFailed）空で、「すべて」と「なし」だけになり、
  // 選んでいる値は「選んでいる値」で残し、帯の下に読めなかったことを出す
  let {
    filter,
    choices,
    categories,
    repositories,
    definitionsFailed,
    onchange,
  }: {
    filter: BacklogFilter;
    choices: BacklogChoices;
    categories: readonly { id: string; name: string }[];
    repositories: readonly { id: string; name: string }[];
    // 区分とリポジトリの一覧を読めなかった
    definitionsFailed: boolean;
    onchange: (next: BacklogFilter) => void;
  } = $props();

  const ids = $props.id();
  const noteId = `${ids}-note`;
  const SEARCH_DELAY_MS = 300;

  // 今の帯の値と、帯が最後に送った絞り込み（lastSent）。木を読み直した（filter が替わった）とき、読んだ値が最後に送った値と同じなら
  // 帯の値はそのままにする（送った後に打ち足した文字、上限を超えて送っていない文字、引き出しの保存の読み直しで消さない）。
  // 違えば帯の外で替わった（トーストや空の状態の「絞り込みを外す」、URL を開き直した）ので、読んだ値に合わせる
  const initial = untrack(() => filter);
  let lastSent: BacklogFilter = { ...initial };
  let selected = $state<Record<FilterSelectKey, string>>({
    assignee: initial.assignee,
    category: initial.category,
    repository: initial.repository,
    epic: initial.epic,
  });
  let text = $state(initial.q);
  let timer: ReturnType<typeof setTimeout> | undefined;
  // IME で変換している間（compositionstart〜compositionend）は、読み直しを予約しない。確定したら予約する
  let composing = false;
  $effect.pre(() => {
    const loaded = filter;
    untrack(() => {
      if (sameFilter(loaded, lastSent)) return;
      clearTimeout(timer);
      timer = undefined;
      lastSent = { ...loaded };
      selected = {
        assignee: loaded.assignee,
        category: loaded.category,
        repository: loaded.repository,
        epic: loaded.epic,
      };
      text = loaded.q;
    });
  });
  $effect(() => () => clearTimeout(timer));

  function normalized(value: string): string {
    return searchWordsOf(value.trim()).join(' ');
  }

  const problem = $derived(backlogQueryProblem(text.trim()));
  const problemText = $derived(
    problem === 'too_long'
      ? t('searchTooLong', { max: BACKLOG_QUERY_MAX_LENGTH })
      : problem === 'too_many_words'
        ? t('searchTooManyWords', { max: BACKLOG_QUERY_MAX_WORDS })
        : '',
  );

  function current(): BacklogFilter {
    return { ...selected, q: problem === null ? normalized(text) : lastSent.q };
  }

  function send(): void {
    clearTimeout(timer);
    timer = undefined;
    lastSent = current();
    onchange(lastSent);
  }

  function searchInput(event?: Event): void {
    clearTimeout(timer);
    timer = undefined;
    if (composing || (event instanceof InputEvent && event.isComposing)) return;
    if (problem !== null || normalized(text) === lastSent.q) return;
    timer = setTimeout(send, SEARCH_DELAY_MS);
  }

  function compositionStart(): void {
    composing = true;
    clearTimeout(timer);
    timer = undefined;
  }

  function compositionEnd(): void {
    composing = false;
    searchInput();
  }

  function searchKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    if (problem === null) send();
  }

  function clear(): void {
    clearTimeout(timer);
    timer = undefined;
    selected = { assignee: '', category: '', repository: '', epic: '' };
    text = '';
    lastSent = { ...emptyFilter };
    onchange(lastSent);
  }

  // 絞り込みを外したら、ボタンが消えるので検索の欄へフォーカスを移す
  let searchInputEl = $state<HTMLInputElement>();
  function clearAndFocus(): void {
    clear();
    searchInputEl?.focus();
  }

  const filtering = $derived(isFiltering(filter) || isFiltering(current()));

  type Option = { value: string; label: string };
  const assigneeOptions = $derived<Option[]>([
    { value: FILTER_ME, label: t('filterMe') },
    ...choices.assignees.map((person) => ({
      value: person.id,
      label: person.current ? person.name : `${person.name}${t('leftMember')}`,
    })),
    { value: FILTER_NONE, label: t('unassigned') },
  ]);
  const categoryOptions = $derived<Option[]>([
    ...categories.map((category) => ({ value: category.id, label: category.name })),
    { value: FILTER_NONE, label: t('categoryNone', { category: t('category') }) },
  ]);
  const repositoryOptions = $derived<Option[]>([
    ...repositories.map((repository) => ({ value: repository.id, label: repository.name })),
    { value: FILTER_NONE, label: t('filterNoRepository') },
  ]);
  const epicOptions = $derived<Option[]>([
    ...choices.epics.map((epic) => ({ value: epic.id, label: epic.title })),
    { value: FILTER_NONE, label: t('filterNoEpic', { epic: t('epic') }) },
  ]);

  const selects = $derived<{ key: FilterSelectKey; label: string; options: Option[]; unloaded: boolean }[]>([
    { key: 'assignee', label: t('assignee'), options: assigneeOptions, unloaded: false },
    { key: 'category', label: t('category'), options: categoryOptions, unloaded: definitionsFailed },
    { key: 'repository', label: t('repository'), options: repositoryOptions, unloaded: definitionsFailed },
    { key: 'epic', label: t('epic'), options: epicOptions, unloaded: false },
  ]);
</script>

<div class="toolbar" role="search" aria-label={t('filterLabel', { backlog: t('backlog') })}>
  <label class="search">
    <Icon name="search" />
    <input
      type="search"
      bind:this={searchInputEl}
      bind:value={text}
      placeholder={t('backlogSearch')}
      aria-label={t('backlogSearch')}
      aria-invalid={problem !== null}
      aria-describedby={problem !== null ? noteId : undefined}
      oninput={searchInput}
      oncompositionstart={compositionStart}
      oncompositionend={compositionEnd}
      onkeydown={searchKeydown}
    />
  </label>
  {#each selects as select (select.key)}
    <select class="select" aria-label={select.label} bind:value={selected[select.key]} onchange={send}>
      <option value="">{t('filterAll', { label: select.label })}</option>
      {#each select.options as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
      {#if selected[select.key] !== '' && !select.options.some((option) => option.value === selected[select.key])}
        <!-- 一覧を読めなかった区分とリポジトリは、消えたかどうか分からないので「選んでいる値」で残す -->
        <option value={selected[select.key]}
          >{select.unloaded ? t('filterSelectedUnloaded') : t('filterUnknown')}</option
        >
      {/if}
    </select>
  {/each}
  {#if filtering}
    <span class="toolbar-end">
      <button class="btn is-sm is-quiet" type="button" onclick={clearAndFocus}
        ><Icon name="x" />{t('filterClear')}</button
      >
    </span>
  {/if}
  {#if problem !== null}
    <p class="field-error toolbar-note" id={noteId} role="alert"><Icon name="alert" />{problemText}</p>
  {/if}
  {#if definitionsFailed}
    <!-- 起票のダイアログと同じ文。区分とリポジトリの選択欄は「すべて」と「なし」（と選んでいる値）だけになる -->
    <p class="field-hint toolbar-note">{t('definitionsLoadFailed', { category: t('category') })}</p>
  {/if}
</div>
