<script lang="ts">
  import { tick } from 'svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import {
    taskAssign,
    taskDelete,
    taskDetail,
    taskHistory,
    taskUpdate,
    type TaskDetail,
    type TaskHistoryEntry,
  } from '../../shared/operations/task/index.ts';
  import { memberList } from '../../shared/operations/workspace/index.ts';
  import {
    LINK_URL_MAX_LENGTH,
    STORY_TEXT_MAX_LENGTH,
    canonicalLinkUrl,
    linkUrlProblem,
    longTextProblem,
    normalizeLinkUrl,
    normalizeLongText,
  } from '../../shared/story.ts';
  import { TASK_POINT_VALUES, TASK_TITLE_MAX_LENGTH, taskTitleProblem } from '../../shared/task.ts';
  import { callOperation } from '../api.ts';
  import { historyEntryView } from '../task-history.ts';
  import { showToast } from '../toast.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';
  import Avatar from './Avatar.svelte';
  import ConfirmDialog from './ConfirmDialog.svelte';
  import Drawer from './Drawer.svelte';
  import DueChip from './DueChip.svelte';
  import Icon from './Icon.svelte';
  import InlineEdit from './InlineEdit.svelte';
  import Markdown from './Markdown.svelte';

  // タスクの詳細の引き出しの中身（kit.js の drawerHtml）。`?task=<ID>` が付いている間、画面の枠（/[slug]/w/[id] のレイアウト）が置く。
  // 開いたら task-detail で1件を読む（本文は長いので、木には載せない）。読んでいる間は読み込み中を出し、読めなければ
  // （404 以外）もう一度試すを出す（フォーカスもそこへ置く）。404 は、トーストで知らせて閉じ、画面が木を読み直す（onremoved）。
  // 欄ごとに、その場で直す。ポイントと期日は選んだら保存し、タイトル、リンク、本文は InlineEdit で確定する（本文は Markdown の部品で描く）。
  // 送る欄は、今の値と違うものだけ。保存したら、その欄だけを応答で入れ替え、画面が木を読み直す（onchanged）。
  // ポイントの保存は1本ずつ送る。送っている間に選び直したら、最後の選択だけを溜め、送り終えた後に送る（矢印キーで動かしても要求が飛び交わず、
  // 応答の順が前後しない）。期日は、年が4桁そろった値だけを、少し待ってから（カレンダーで選んだとき）か、欄を離れる／Enter で保存する。
  // 担当は、アバターと選択欄で、選んで少し待ってから（閉じた選択欄の矢印キーは1つ動くたびに change を出すため）か、欄を離れたときに、
  // 最後の値だけを task-assign で保存する（期日と同じく、待っている間は書きかけに数える。送るのは1本ずつで、送っている間に選び直した分は
  // 最後の選択だけを送る）。選択欄を出している間は、名前を選択欄が読むので、アバターは読み上げから外す。
  // 候補は、読み込めた後に member-list の members（今所属している人）を読む。今の担当が候補にいない（抜けた）ときは、
  // その人を「名前（離脱済み）」の選択肢として残す。候補を読めなければ、担当なしと今の担当だけを選べ、読めなかったことと「もう一度試す」を添える。
  // 完了したタスクの担当は替えない（アバターと名前だけにして理由を添える）。
  // 完了したタスクのポイントは直せない（欄を読み取り専用にして理由を添える）。取り込んだタスクのタイトルとリンクと削除も直せない。
  // 閉じたワークスペース（canWrite が偽）では、直す口と削除を出さず、読み取り専用で開く。
  // 書きかけ（タイトル、リンク、本文の直している途中で、保存と同じ整え方の後も値が保存した値と違うもの。保存の要求を送っている間も数える。
  // と、まだ送っていない期日の入力）があるまま閉じる（×、幕、Esc）か、別のタスクや別の画面へ移る（beforeNavigate）ときは、
  // 捨てるかをアプリの中のダイアログで確かめる。捨てると決めたら、閉じる／移る。送っている最中の要求は止められず、そのまま通る。
  // 閉じた後に返った保存の応答も、通ったら木を読み直してトーストで知らせ、失敗はトーストで知らせる（saveFields）。
  // 引き出しが読み直すのは木（onchanged）かワークスペースの枠（onstale）だけで、組織の枠は読み直さない。
  // 削除は確認のダイアログを挟む。消したら閉じ、トーストで知らせ、画面が木を読み直す（onremoved）。
  // 本文の下に「変更の履歴」の節を置く（task-history。新しい順に 50 件ずつで、続きは「さらに読む」で足す）。
  // 読み込めたときと、引き出しで保存した後に読み直す。列の名前と値の文は src/lib/task-history.ts が辞書の言葉で作る。
  // コメント（#171）が入ったら、見本（kit.js の drawerHtml）どおりのタブにする
  let {
    slug,
    workspaceId,
    taskId,
    canWrite,
    onclose,
    onchanged,
    onstale,
    onremoved,
  }: {
    slug: string;
    workspaceId: string;
    taskId: string;
    canWrite: boolean;
    // 閉じる。画面の枠が `?task=` を外し、フォーカスを行へ戻す
    onclose: () => void;
    // 欄を保存した。画面が木だけを読み直す（枠の読み直しが一時的に失敗しても、引き出しと書きかけを失わないため）
    onchanged: () => void;
    // ワークスペースの状態が変わっていた（閉じた）。画面が枠ごと読み直す
    onstale: () => void;
    // タスクが消えた（削除した、見つからない）。画面が閉じて、木を読み直す
    onremoved: () => void;
  } = $props();

  const ids = $props.id();
  const titleLabelId = `${ids}-title`;
  const pointsLabelId = `${ids}-points`;
  const pointsReasonId = `${ids}-points-reason`;
  const pointsErrorId = `${ids}-points-error`;
  const dueId = `${ids}-due`;
  const dueErrorId = `${ids}-due-error`;
  const assigneeId = `${ids}-assignee`;
  const assigneeNoteId = `${ids}-assignee-note`;
  const assigneeErrorId = `${ids}-assignee-error`;
  const readOnlyId = `${ids}-readonly`;
  const historyHeadingId = `${ids}-history`;

  type PointsChoice = (typeof TASK_POINT_VALUES)[number] | null;
  // 先頭が「未」（未見積もり）
  const pointChoices: readonly PointsChoice[] = [null, ...TASK_POINT_VALUES];

  // 期日を、選んでから保存するまでの待ち。年を打つ間と、矢印キーで動かす間の保存をまとめる
  const DUE_DEBOUNCE_MS = 600;
  // 期日の年が4桁そろったとみなす下限。打ちかけの年（0002、0020、0202）は、4桁の文字でも送らない
  const DUE_MIN_YEAR = 1000;

  let loadState = $state<'loading' | 'ready' | 'failed'>('loading');
  let task = $state<TaskDetail | null>(null);
  // 期日の印を決める、ワークスペースの今日と週の始まり（task-detail の値。ブラウザの時計に頼らない）
  let clock = $state<{ today: string; weekStart: number } | null>(null);
  let heading = $state<HTMLElement>();
  let retryButton = $state<HTMLButtonElement>();
  let discardDialog = $state<ReturnType<typeof ConfirmDialog>>();
  let deleteDialog = $state<ReturnType<typeof ConfirmDialog>>();

  // 直している途中の欄ごとの書きかけ（保存の要求を送っている間も数える）
  const dirty = $state({ title: false, link: false, body: false });
  // 書きかけ。タイトル、リンク、本文の書きかけと、まだ送っていない期日の入力（待っている間と、打ちかけ）と担当の選択（待っている間）
  function hasDraft(): boolean {
    return dirty.title || dirty.link || dirty.body || dueUnsent() || assigneeChoice !== null;
  }

  // 選んだポイント。送っている間（と、続けて選んだ分を送り終えるまで）は、最後に選んだ値を見せる
  let pointsPending = $state<{ value: PointsChoice } | null>(null);
  const pointsShown = $derived<PointsChoice>(pointsPending !== null ? pointsPending.value : (task?.points ?? null));
  let pointsError = $state<string | null>(null);
  let pointsSending = false;
  let dueError = $state<string | null>(null);
  let dueInput = $state<HTMLInputElement>();
  let dueTimer: ReturnType<typeof setTimeout> | undefined;
  let dueSending = false;
  let dueAgain = false;
  // 期日の入力欄が、保存した値と同じ（同期済み）か、最後に送った値のときの文字。入力がこれと違えば、まだ送っていない入力がある
  let dueBase = '';
  let dueBoundTo: HTMLInputElement | undefined;
  // タスクが消えていた。保存の続きを送らない
  let taskGone = false;
  let deleting = $state(false);
  let deleteError = $state<string | null>(null);
  let loadVersion = 0;

  // 部品が外れた後の応答で、状態を触らない
  let alive = true;
  $effect(() => () => {
    alive = false;
    clearTimeout(dueTimer);
    clearTimeout(assigneeTimer);
  });

  // 捨てると決めた後、閉じる／移るために確認を飛ばす
  let leaving = false;
  let asking = false;

  // 担当の候補（そのワークスペースに今所属している人）。読み込む前と読めなかったときは null
  let candidates = $state<readonly { id: string; name: string }[] | null>(null);
  let candidatesFailed = $state(false);
  let candidatesVersion = 0;
  let candidatesLoading = $state(false);
  // 選択欄で選んで、まだ送っていない担当（待っている間）。閉じた選択欄で矢印キーを押すと、1つ動くたびに change が出るので、
  // 期日と同じく少し待ってから（か欄を離れたときに）最後の値だけを送る
  let assigneeChoice = $state<{ value: string } | null>(null);
  let assigneeTimer: ReturnType<typeof setTimeout> | undefined;
  let assigneeSelect = $state<HTMLSelectElement>();
  // 送っている担当（空は担当なし）。送っている間（と、続けて選んだ分を送り終えるまで）は、最後に選んだ値を見せる
  let assigneePending = $state<{ value: string } | null>(null);
  let assigneeError = $state<string | null>(null);
  let assigneeSending = false;

  const pointsEditable = $derived(canWrite && task !== null && task.completed_at === null);
  const assigneeEditable = $derived(canWrite && task !== null && task.completed_at === null);
  const assigneeShownId = $derived(
    assigneeChoice !== null
      ? assigneeChoice.value
      : assigneePending !== null
        ? assigneePending.value
        : (task?.assignee?.id ?? ''),
  );
  // 選択欄の選択肢。候補に、今の担当が候補にいなければ（抜けた、候補を読めなかった）その人を足す
  const assigneeOptions = $derived.by(() => {
    const options: { id: string; name: string; left: boolean }[] = (candidates ?? []).map((candidate) => ({
      ...candidate,
      left: false,
    }));
    const current = task?.assignee ?? null;
    if (current !== null && !options.some((option) => option.id === current.id)) options.unshift(current);
    return options;
  });
  // アバターに出す人。選んだ候補か今の担当
  const assigneeShown = $derived(assigneeOptions.find((option) => option.id === assigneeShownId) ?? null);
  // 選択欄の値を、見せる値に合わせる。保存に失敗して前の値へ戻すときと、候補を読み直して選択肢が替わったときも合わせる
  $effect(() => {
    const select = assigneeSelect;
    const value = assigneeShownId;
    void assigneeOptions;
    if (select !== undefined && select.value !== value) select.value = value;
  });
  const titleEditable = $derived(canWrite && task !== null && !task.is_imported);
  const done = $derived(task?.completed_at != null);

  // ---- 変更の履歴（task-history） ----
  let historyState = $state<'loading' | 'ready' | 'failed'>('loading');
  let historyEntries = $state.raw<readonly TaskHistoryEntry[]>([]);
  let historyNext = $state<{ created_at: string; id: string } | null>(null);
  let historyTimezone = $state('UTC');
  // 「さらに読む」の状態
  let historyMore = $state<'idle' | 'loading' | 'failed'>('idle');
  // 先頭を読み直している間（「さらに読む」を止め、「もう一度試す」を押せなくする）
  let historyReloading = $state(false);
  // 行を出した後の読み直し（保存した後）に失敗した。行は残し、節の上に失敗と「もう一度試す」を添える
  let historyReloadFailed = $state(false);
  let historyVersion = 0;
  let historyHeading = $state<HTMLElement>();
  // 「さらに読む」で足したことの知らせ。節の中に常に置いた role="status" の領域に入れる
  let historyAdded = $state('');
  // 履歴の読み込みの進み具合を読み上げに伝える（見える「読み込んでいます」は aria-hidden にする）
  const historyStatus = $derived(historyState === 'loading' || historyMore === 'loading' ? t('loading') : historyAdded);
  // 言葉づかいを切り替えたら、列の名前と操作の言葉も描き直す（t を $derived の中で呼ぶ）
  const historyViews = $derived(historyEntries.map((entry) => historyEntryView(entry, historyTimezone, t)));

  // 先頭の 50 件を読み直す。読み直している間は、前に読めた行を残す（保存のたびに消えてちらつかない）。
  // 失敗したら、行がまだ無ければ節を失敗の表示に、行があれば行を残して失敗を添える。
  // focusAfter は「もう一度試す」から読んだとき。読めたらボタンが消えるので、節の見出しへフォーカスを移す
  async function loadHistory(focusAfter = false): Promise<void> {
    const mine = ++historyVersion;
    historyReloading = true;
    historyMore = 'idle';
    const result = await callOperation(taskHistory, { workspace_id: workspaceId, task_id: taskId }, { slug });
    if (!alive || mine !== historyVersion) return;
    historyReloading = false;
    if (result.ok) {
      historyEntries = result.data.entries;
      historyNext = result.data.next;
      historyTimezone = result.data.timezone;
      historyState = 'ready';
      historyReloadFailed = false;
      if (focusAfter) {
        await tick();
        if (alive) historyHeading?.focus();
      }
      return;
    }
    // 404 はタスクが消えた（別の人が削除した）。もう一度試しても読めないので、閉じる側へ回す
    if (result.status === 404) {
      if (!taskGone) gone();
      return;
    }
    if (historyState === 'ready') historyReloadFailed = true;
    else historyState = 'failed';
  }

  function retryHistory(): void {
    if (historyReloading) return;
    void loadHistory(true);
  }

  // 続きの 50 件を足す。先頭を読み直している間は押しても何もしない。先頭を読み直したら、古い続きの応答は捨てる
  async function loadMoreHistory(): Promise<'added' | 'dropped' | 'failed'> {
    const before = historyNext;
    if (before === null || historyMore === 'loading' || historyReloading) return 'dropped';
    const mine = historyVersion;
    historyMore = 'loading';
    historyAdded = '';
    const result = await callOperation(taskHistory, { workspace_id: workspaceId, task_id: taskId, before }, { slug });
    if (!alive || mine !== historyVersion) return 'dropped';
    if (result.ok) {
      historyEntries = [...historyEntries, ...result.data.entries];
      historyNext = result.data.next;
      historyMore = 'idle';
      historyAdded = t('historyMoreAdded', { count: result.data.entries.length });
      return 'added';
    }
    historyMore = 'failed';
    return 'failed';
  }

  // 「さらに読む」。読み足して続きが無くなると押したボタンが消えるので、フォーカスを節の見出しへ移す
  async function showMoreHistory(): Promise<void> {
    const outcome = await loadMoreHistory();
    if (!alive || outcome !== 'added' || historyNext !== null) return;
    await tick();
    historyHeading?.focus();
  }

  async function load(): Promise<void> {
    const mine = ++loadVersion;
    loadState = 'loading';
    const result = await callOperation(taskDetail, { workspace_id: workspaceId, task_id: taskId }, { slug });
    if (!alive || mine !== loadVersion) return;
    if (result.ok) {
      task = result.data.task;
      clock = { today: result.data.today, weekStart: result.data.week_start };
      loadState = 'ready';
      void loadHistory();
      // 担当を選べるときだけ、候補を読む（読み取り専用では選択欄を出さない）
      if (canWrite && result.data.task.completed_at === null && candidates === null) void loadCandidates();
      // 開いたときの読み上げに、見出しが読まれるようにする。閉じるボタンか何も無い所にフォーカスがあるときだけ移す
      await tick();
      if (!alive) return;
      const active = document.activeElement;
      if (active === document.body || active?.classList.contains('drawer-close')) heading?.focus();
      return;
    }
    if (result.status === 401) {
      onstale();
      return;
    }
    // 400 は、URL の `?task=` が ID の形でないとき。見つからないのと同じに扱う
    if (result.status === 404 || result.status === 400) {
      gone();
      return;
    }
    loadState = 'failed';
    // 失敗の文と「もう一度試す」へ、フォーカスを移す（開いたときの閉じるボタンに残さない）
    await tick();
    if (alive && mine === loadVersion) retryButton?.focus();
  }

  void load();

  // タスクが消えていた（別の人が削除した）。閉じて、木を読み直す
  function gone(): void {
    leaving = true;
    taskGone = true;
    showToast(t('taskGone', { task: t('task') }), 'alert');
    onremoved();
  }

  // 閉じる操作。書きかけがあれば、捨てるかを確かめる
  async function requestClose(): Promise<void> {
    if (asking || leaving) return;
    if (hasDraft() && !(await confirmDiscard())) return;
    leaving = true;
    onclose();
  }

  async function confirmDiscard(): Promise<boolean> {
    asking = true;
    try {
      return (await discardDialog?.ask()) ?? false;
    } finally {
      asking = false;
    }
  }

  // 別のタスクや別の画面へ移るとき（戻る／進む、行のリンク、左のメニュー）も、書きかけがあれば確かめる。
  // 同じタスクのままの移動と、閉じると決めた後は通す。ページを離れる（タブを閉じる、外のサイト）ときは、cancel() がブラウザの確認を出す。
  // 捨てると決めた後、戻る／進むは履歴をその分だけ動かす（goto は履歴を積んでしまう）
  beforeNavigate((navigation) => {
    if (leaving || !hasDraft()) return;
    if (navigation.to === null) {
      navigation.cancel();
      return;
    }
    const to = navigation.to.url;
    if (to.origin === location.origin && to.pathname === location.pathname && to.searchParams.get('task') === taskId) {
      return;
    }
    const delta = navigation.type === 'popstate' ? navigation.delta : undefined;
    navigation.cancel();
    if (asking) return;
    void confirmDiscard().then((discard) => {
      if (!discard) return;
      leaving = true;
      if (to.origin !== location.origin) location.href = to.href;
      else if (delta !== undefined && delta !== 0) history.go(delta);
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- 行き先は SvelteKit が解決した URL（navigation.to）で、経路から作り直せない
      else void goto(to, { reset: to.pathname !== location.pathname });
    });
  });

  // 保存に使う応答の扱い。送った欄だけを応答で入れ替える（別の欄の保存と前後しても、古い値で戻さない）
  type Fields = Partial<Pick<TaskDetail, 'title' | 'points' | 'due_on' | 'link_url' | 'body_md'>>;

  // 欄を書く。成功なら null、失敗ならエラーの文。404 は閉じる側へ回す（文は返さず、taskGone を立てる）。
  // 引き出しが閉じた後に返った応答（欄を離れた直後に × を押した、ポイントを選んだ直後に閉じた）も、黙って捨てない:
  // 通ったら木を読み直してトーストで知らせ、失敗はトーストで知らせる（画面の状態は触らない）
  async function saveFields(fields: Fields): Promise<string | null> {
    const result = await callOperation(taskUpdate, { workspace_id: workspaceId, task_id: taskId, ...fields }, { slug });
    if (result.ok) {
      if (alive && task !== null) {
        const saved = result.data.task;
        const merged: TaskDetail = { ...task, completed_at: saved.completed_at, can_delete: saved.can_delete };
        for (const key of Object.keys(fields) as (keyof Fields)[]) Object.assign(merged, { [key]: saved[key] });
        task = merged;
        void loadHistory();
      }
      showToast(t('taskSaved'), 'check');
      onchanged();
      return null;
    }
    if (result.status === 404) {
      taskGone = true;
      if (alive) gone();
      else {
        showToast(t('taskGone', { task: t('task') }), 'alert');
        onchanged();
      }
      return null;
    }
    let message: string;
    if (result.status === 401) {
      onstale();
      message = t('taskSaveFailed');
    } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
      // 閉じた。枠を読み直して、読み取り専用の表示に切り替える
      onstale();
      message = t('workspaceClosedReadOnly', { workspace: t('workspace') });
    } else if (result.status === 409) {
      message = await conflictMessage(fields);
    } else {
      message = result.status === 400 ? t('taskBadRequest') : t('taskSaveFailed');
    }
    if (!alive) showToast(message, 'alert');
    return message;
  }

  // 409 の文。断った理由は、読み直した今の値で決める（完了していればポイントが理由、取り込んだタスクならタイトルとリンクが理由、
  // どちらでもなければ、同じ欄を同時に直された）。読み直した値は、引き出しが開いていれば表示にも入れる
  async function conflictMessage(fields: Fields): Promise<string> {
    const latest = await refresh();
    const current = latest ?? task;
    if ('points' in fields && current?.completed_at != null) {
      return t('taskSaveConflict', { task: t('task'), done: t('done'), points: t('points') });
    }
    if (current?.is_imported && ('title' in fields || 'link_url' in fields)) {
      return t('taskImportedLocked', { task: t('task') });
    }
    return t('taskSaveRaced');
  }

  // 今の値を読み直す。読めなければ今の表示のまま（null）
  async function refresh(): Promise<TaskDetail | null> {
    const result = await callOperation(taskDetail, { workspace_id: workspaceId, task_id: taskId }, { slug });
    if (!result.ok) return null;
    if (alive) {
      task = result.data.task;
      clock = { today: result.data.today, weekStart: result.data.week_start };
    }
    return result.data.task;
  }

  // ---- 担当（選んで少し待ってから、か欄を離れたときに保存する。1本ずつ送る） ----
  // 候補を読む。読めなければ、担当なしと今の担当だけを選べるままにし、読めなかったことと「もう一度試す」を添える
  async function loadCandidates(): Promise<void> {
    const mine = ++candidatesVersion;
    candidatesLoading = true;
    const result = await callOperation(memberList, { workspace_id: workspaceId }, { slug });
    if (!alive || mine !== candidatesVersion) return;
    candidatesLoading = false;
    if (result.ok) {
      candidates = result.data.members.map((member) => ({ id: member.id, name: member.name }));
      candidatesFailed = false;
    } else {
      candidatesFailed = true;
    }
  }

  // 候補を読み直す。読めたら、押したボタンは消えるので、担当の選択欄へフォーカスを移す
  async function retryCandidates(): Promise<void> {
    if (candidatesLoading) return;
    await loadCandidates();
    if (!alive || candidatesFailed) return;
    await tick();
    assigneeSelect?.focus();
  }

  function onAssigneeChange(event: Event & { currentTarget: HTMLSelectElement }): void {
    assigneeChoice = { value: event.currentTarget.value };
    scheduleAssignee();
  }

  // 待ってから送る。捨てるかの確認を出している間は送らず、待ちを延ばす（期日と同じ）
  function scheduleAssignee(): void {
    clearTimeout(assigneeTimer);
    assigneeTimer = setTimeout(() => {
      if (asking) scheduleAssignee();
      else if (!leaving) commitAssignee();
    }, DUE_DEBOUNCE_MS);
  }

  function onAssigneeBlur(): void {
    // 捨てるかの確認にフォーカスが移ったときと、捨てると決めて部品が外れるときは、送らない（期日と同じ）
    if (asking || leaving) return;
    commitAssignee();
  }

  // 待っている選択を、送る列へ渡す
  function commitAssignee(): void {
    clearTimeout(assigneeTimer);
    const choice = assigneeChoice;
    if (choice === null) return;
    assigneeChoice = null;
    chooseAssignee(choice.value);
  }

  function chooseAssignee(value: string): void {
    // 送っている間に選び直されたら、最後の選択だけを残す
    assigneePending = { value };
    if (!assigneeSending) void sendAssignee();
  }

  // ポイントと同じく、引き出しが閉じた後も溜めた最後の選択まで送る。タスクが消えたか、完了にされていたら、溜めた分を捨てる
  async function sendAssignee(): Promise<void> {
    assigneeSending = true;
    try {
      while (assigneePending !== null && !taskGone) {
        const choice = assigneePending.value;
        if (task === null || choice === (task.assignee?.id ?? '') || task.completed_at !== null) {
          assigneePending = null;
          break;
        }
        assigneeError = null;
        const message = await saveAssignee(choice === '' ? null : choice);
        if (message !== null) {
          assigneeError = message;
          if (assigneePending === null || assigneePending.value === choice) assigneePending = null;
          continue;
        }
        if (assigneePending !== null && assigneePending.value === choice) assigneePending = null;
      }
      if (taskGone) assigneePending = null;
    } finally {
      assigneeSending = false;
    }
  }

  // 担当を書く。成功なら null、失敗ならエラーの文（saveFields と同じ扱い）。404 は、タスクが消えたか、選んだ人が所属を外れたかを、
  // 読み直して分ける（タスクがあれば、候補を読み直して、選び直しを促す）
  async function saveAssignee(assigneeUserId: string | null): Promise<string | null> {
    const result = await callOperation(
      taskAssign,
      { workspace_id: workspaceId, task_id: taskId, assignee_user_id: assigneeUserId },
      { slug },
    );
    if (result.ok) {
      if (alive && task !== null) {
        const saved = result.data.task;
        task = { ...task, assignee: saved.assignee, completed_at: saved.completed_at, can_delete: saved.can_delete };
        void loadHistory();
      }
      showToast(t('taskSaved'), 'check');
      onchanged();
      return null;
    }
    let message: string;
    if (result.status === 404) {
      const latest = await callOperation(taskDetail, { workspace_id: workspaceId, task_id: taskId }, { slug });
      if (!latest.ok && latest.status === 404) {
        taskGone = true;
        if (alive) gone();
        else {
          showToast(t('taskGone', { task: t('task') }), 'alert');
          onchanged();
        }
        return null;
      }
      if (!latest.ok) {
        // 読み直せなかった（通信、5xx など）。どちらが理由か分からないので、ふつうの失敗の文にする
        message = t('taskSaveFailed');
      } else {
        if (alive) {
          task = latest.data.task;
          clock = { today: latest.data.today, weekStart: latest.data.week_start };
          void loadCandidates();
        }
        message = t('assigneeNotMember', { workspace: t('workspace'), assignee: t('assignee') });
      }
    } else if (result.status === 401) {
      onstale();
      message = t('taskSaveFailed');
    } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
      onstale();
      message = t('workspaceClosedReadOnly', { workspace: t('workspace') });
    } else if (result.status === 409) {
      // 完了にされていれば、それが理由。そうでなければ、同時に担当を替えられた
      const latest = await refresh();
      message =
        (latest ?? task)?.completed_at != null
          ? t('taskAssigneeDone', { task: t('task'), done: t('done'), assignee: t('assignee') })
          : t('taskSaveRaced');
    } else {
      message = result.status === 400 ? t('taskBadRequest') : t('taskSaveFailed');
    }
    if (!alive) showToast(message, 'alert');
    return message;
  }

  // ---- タイトル、リンク、本文（InlineEdit） ----
  function titleProblem(raw: string): string | null {
    const problem = taskTitleProblem(raw.trim());
    if (problem === 'required') return t('taskTitleRequired');
    if (problem === 'too_long') return t('taskTitleTooLong', { max: TASK_TITLE_MAX_LENGTH });
    if (problem === 'invalid_character') return t('taskTitleInvalidCharacter');
    return null;
  }

  function saveTitle(raw: string): Promise<string | null> {
    const next = raw.trim();
    return task === null || next === task.title ? Promise.resolve(null) : saveFields({ title: next });
  }

  function linkProblemMessage(raw: string): string | null {
    const value = normalizeLinkUrl(raw);
    const problem = value === null ? null : linkUrlProblem(value);
    if (problem === 'too_long') return t('linkTooLong', { max: LINK_URL_MAX_LENGTH });
    if (problem === 'invalid_url') return t('linkInvalid');
    return null;
  }

  // 保存する形の文字（空は空、使える URL は解釈した URL）。書きかけの判定にも使う
  function linkForm(raw: string): string {
    const value = normalizeLinkUrl(raw);
    if (value === null) return '';
    return linkUrlProblem(value) === null ? canonicalLinkUrl(value) : value;
  }

  function saveLink(raw: string): Promise<string | null> {
    const value = normalizeLinkUrl(raw);
    return task === null || linkForm(raw) === (task.link_url ?? '')
      ? Promise.resolve(null)
      : saveFields({ link_url: value });
  }

  function bodyProblem(raw: string): string | null {
    const value = normalizeLongText(raw);
    const problem = value === null ? null : longTextProblem(value);
    if (problem === 'too_long') return t('fieldTextTooLong', { field: t('fieldBody'), max: STORY_TEXT_MAX_LENGTH });
    if (problem === 'invalid_character') return t('fieldTextInvalidCharacter', { field: t('fieldBody') });
    return null;
  }

  function saveBody(raw: string): Promise<string | null> {
    const next = normalizeLongText(raw);
    return task === null || next === task.body_md ? Promise.resolve(null) : saveFields({ body_md: next });
  }

  // ---- ポイント（選んだら保存する。1本ずつ送る） ----
  function choosePoints(choice: PointsChoice): void {
    // 送っている間に選び直されたら、最後の選択だけを残す
    pointsPending = { value: choice };
    if (!pointsSending) void sendPoints();
  }

  // 引き出しが閉じた後も、溜めた最後の選択まで送る（選んだ値を黙って失わない）。送った結果の通知は saveFields がする。
  // 先の要求が失敗しても、送っている間に選び直された最後の選択は捨てずに送る（次の送信を始めるときに、前の失敗の文は消す）。
  // タスクが消えた（404）か、完了にされていた（ポイントを直せない）ときは、同じ要求を繰り返さず、溜めた分を捨てる
  async function sendPoints(): Promise<void> {
    pointsSending = true;
    try {
      while (pointsPending !== null && !taskGone) {
        const choice = pointsPending.value;
        // 保存した値（最後に送って通った値）と同じなら送らない
        if (task === null || choice === task.points || task.completed_at !== null) {
          pointsPending = null;
          break;
        }
        pointsError = null;
        const message = await saveFields({ points: choice });
        if (message !== null) {
          pointsError = message;
          // 選び直されていなければ、ここで終わる。選び直されていれば、次の周で最後の選択を送る
          if (pointsPending === null || pointsPending.value === choice) pointsPending = null;
          continue;
        }
        if (pointsPending !== null && pointsPending.value === choice) pointsPending = null;
      }
      if (taskGone) pointsPending = null;
    } finally {
      pointsSending = false;
    }
  }

  // ---- 期日（年が4桁そろった値だけを、待ってから、か欄を離れる／Enter で保存する） ----
  function dueIsComplete(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number(value.slice(0, 4)) >= DUE_MIN_YEAR;
  }

  function onDueChange(): void {
    clearTimeout(dueTimer);
    dueError = null;
    const value = dueInput?.value ?? '';
    // 打ちかけの年は送らない。欄を離れたときに、直っていなければ知らせる
    if (value !== '' && !dueIsComplete(value)) return;
    scheduleDue();
  }

  // 待ってから送る。捨てるかの確認を出している間は送らず、待ちを延ばす（捨てれば部品が外れて止まり、書き続ければ続きから送る）
  function scheduleDue(): void {
    clearTimeout(dueTimer);
    dueTimer = setTimeout(() => {
      if (asking) scheduleDue();
      else if (!leaving) void commitDue(false);
    }, DUE_DEBOUNCE_MS);
  }

  function onDueKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    clearTimeout(dueTimer);
    void commitDue(true);
  }

  function onDueBlur(): void {
    // 捨てるかの確認のダイアログにフォーカスが移ったときと、捨てると決めて部品が外れるとき（Chrome は、フォーカスのある要素が
    // 外れると blur を出す）は、送らない（待っている入力は書きかけとして確かめた結果、捨てる）
    if (asking || leaving) return;
    clearTimeout(dueTimer);
    void commitDue(true);
  }

  // 入力欄の値は、保存した値に追従させる。ただし、入力が最後に同期した（か送った）値のままのときだけ。
  // 送っている間に次の値を選んだ（入力が違う）ときは、先の応答で上書きしない
  $effect(() => {
    const saved = task?.due_on ?? '';
    const input = dueInput;
    if (input === undefined) return;
    if (input !== dueBoundTo) {
      dueBoundTo = input;
      dueBase = input.value;
    }
    if (input.value === dueBase) {
      input.value = saved;
      dueBase = saved;
    }
  });

  // まだ送っていない期日の入力がある（待っている間、打ちかけ、送っている間に選んだ次の値）
  function dueUnsent(): boolean {
    return dueInput !== undefined && dueInput.value !== dueBase;
  }

  // final は、欄を離れたか Enter。書けない値のときだけ、ここで知らせる
  async function commitDue(final: boolean): Promise<void> {
    const input = dueInput;
    if (task === null || input === undefined || taskGone) return;
    if (dueSending) {
      dueAgain = true;
      return;
    }
    const value = input.value;
    // 途中までしか打たれていない値や存在しない日付は、value が空になり、validity.badInput が立つ
    if (input.validity.badInput || (value !== '' && !dueIsComplete(value))) {
      if (final) dueError = t('dueInvalid', { due: t('due') });
      return;
    }
    const next = value === '' ? null : value;
    if (next === task.due_on) {
      dueBase = value;
      return;
    }
    dueSending = true;
    dueBase = value;
    dueError = null;
    try {
      const message = await saveFields({ due_on: next });
      if (message !== null) {
        dueError = message;
        // 失敗したら、保存した値へ戻す。ただし、送っている間に打っている次の値は消さない
        if (alive && input.value === value) {
          input.value = task?.due_on ?? '';
          dueBase = input.value;
        }
      }
    } finally {
      dueSending = false;
    }
    // 送っている間に値が変わっていたら、送り終えた後に、今の値を送る
    if (dueAgain) {
      dueAgain = false;
      if (alive) await commitDue(true);
    }
  }

  function clearDue(): void {
    if (dueInput === undefined) return;
    clearTimeout(dueTimer);
    dueInput.value = '';
    // 「クリア」は空にすると消えるので、フォーカスを期日の入力欄へ移す
    dueInput.focus();
    void commitDue(true);
  }

  // ---- 削除 ----
  async function remove(event: MouseEvent): Promise<void> {
    if (task === null || deleting || asking) return;
    const trigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    asking = true;
    let confirmed: boolean;
    try {
      confirmed = (await deleteDialog?.ask(trigger)) ?? false;
    } finally {
      asking = false;
    }
    if (!confirmed || !alive) return;
    deleting = true;
    deleteError = null;
    try {
      const result = await callOperation(taskDelete, { workspace_id: workspaceId, task_id: taskId }, { slug });
      if (!alive) {
        // 削除の要求を送っている間に閉じられた。結果は黙って捨てず、通ったら木を読み直して知らせ、失敗は知らせる
        if (result.ok) {
          showToast(t('taskDeleted', { task: t('task') }), 'check');
          onchanged();
        } else if (result.status === 404) {
          onchanged();
        } else {
          showToast(t('taskDeleteFailed'), 'alert');
        }
        return;
      }
      if (result.ok) {
        // 消えたので、書きかけがあっても確かめずに閉じる
        leaving = true;
        showToast(t('taskDeleted', { task: t('task') }), 'check');
        onremoved();
      } else if (result.status === 401) {
        onstale();
      } else if (result.status === 404) {
        gone();
      } else if (result.status === 403) {
        deleteError = t('taskDeleteForbidden', { leader: t('leader') });
      } else if (result.status === 409 && result.error?.code === 'workspace_closed') {
        deleteError = t('workspaceClosedReadOnly', { workspace: t('workspace') });
        onstale();
      } else if (result.status === 409) {
        // 取り込んだタスクは削除できない
        deleteError = t('taskImportedNoDelete', { task: t('task'), archive: t('archive') });
        void refresh();
      } else {
        deleteError = t('taskDeleteFailed');
      }
    } finally {
      if (alive) deleting = false;
    }
  }

  const status = $derived(loadState === 'loading' ? t('loading') : deleting ? t('taskDeleting') : '');
</script>

{#snippet titleView(begin: ((event: Event) => void) | null)}
  <!-- tabindex="-1" は、開いたときに見出しへフォーカスを置くため（キーボードの Tab 順には入らない） -->
  <h2 class="drawer-title" tabindex="-1" bind:this={heading}>
    {#if begin !== null}
      <button class="edit-trigger" type="button" onclick={begin}>
        <span id={titleLabelId}>{task?.title}</span>
        <Icon name="pen" />
        <span class="visually-hidden">{t('taskTitleEditHint', { task: t('task') })}</span>
      </button>
    {:else}
      <span id={titleLabelId}>{task?.title}</span>
    {/if}
  </h2>
{/snippet}

{#snippet bodyView()}
  {#if task?.body_md != null}
    <Markdown source={task.body_md} headingStart={3} />
  {:else}
    <div class="doc-box is-empty">{t('bodyEmpty')}</div>
  {/if}
{/snippet}

<Drawer labelledBy={titleLabelId} busy={loadState === 'loading'} onrequestclose={() => void requestClose()}>
  {#snippet top()}
    {#if task !== null}
      <span class="chip"
        ><Icon name={task.is_imported ? 'link' : 'pen'} />{task.is_imported
          ? t('taskImportedChip', { task: t('task') })
          : t('taskManualChip', { task: t('task') })}</span
      >
      {#if done}<span class="chip is-ok"><Icon name="check" />{t('done')}</span>{/if}
    {/if}
  {/snippet}

  {#if loadState === 'loading'}
    <!-- 読み上げは下の role="status" が伝えるので、見える文字だけにする -->
    <h2 class="drawer-title" tabindex="-1" bind:this={heading}><span id={titleLabelId}>{t('task')}</span></h2>
    <p class="field-hint" aria-hidden="true">{t('loading')}</p>
  {:else if loadState === 'failed'}
    <h2 class="drawer-title" tabindex="-1" bind:this={heading}><span id={titleLabelId}>{t('task')}</span></h2>
    <div class="callout is-danger" role="alert">
      <Icon name="alert" /><span>{t('taskDrawerLoadFailed', { task: t('task') })}</span>
    </div>
    <div class="form-actions">
      <button class="btn" type="button" bind:this={retryButton} onclick={() => void load()}>{t('retry')}</button>
    </div>
  {:else if task !== null}
    {#if !canWrite}
      <div class="callout is-info" id={readOnlyId}>
        <Icon name="shield" /><span>{t('taskReadOnly', { workspace: t('workspace'), task: t('task') })}</span>
      </div>
    {/if}

    {#if titleEditable}
      <InlineEdit
        value={task.title}
        label={t('fieldTitle')}
        labelHidden
        placeholder={t('taskTitlePlaceholder')}
        problem={titleProblem}
        save={saveTitle}
        normalize={(raw) => raw.trim()}
        ondirty={(value) => (dirty.title = value)}
      >
        {#snippet view(begin)}{@render titleView(begin)}{/snippet}
      </InlineEdit>
    {:else}
      {@render titleView(null)}
    {/if}
    {#if task.is_imported}
      <span class="props-note">{t('taskImportedNote', { task: t('task') })}</span>
    {/if}

    <dl class="props">
      <div>
        <dt>
          {#if assigneeEditable}<label for={assigneeId}>{t('assignee')}</label>{:else}{t('assignee')}{/if}
        </dt>
        <dd>
          <!-- 名前は隣の選択欄か文字が読むので、アバターはいつも読み上げから外す（二重に読ませない） -->
          {#if assigneeShown === null}
            <Avatar userId={null} decorative />
          {:else}
            <Avatar userId={assigneeShown.id} name={assigneeShown.name} left={assigneeShown.left} decorative />
          {/if}
          {#if assigneeEditable}
            <select
              class="select"
              id={assigneeId}
              bind:this={assigneeSelect}
              onchange={onAssigneeChange}
              onblur={onAssigneeBlur}
              aria-busy={candidatesLoading}
              aria-invalid={assigneeError !== null}
              aria-describedby={[
                candidatesFailed ? assigneeNoteId : null,
                assigneeError !== null ? assigneeErrorId : null,
              ]
                .filter((id) => id !== null)
                .join(' ') || undefined}
            >
              <option value="" selected={assigneeShownId === ''}>{t('unassigned')}</option>
              {#each assigneeOptions as option (option.id)}
                <option value={option.id} selected={option.id === assigneeShownId}
                  >{option.left ? `${option.name}${t('leftMember')}` : option.name}</option
                >
              {/each}
            </select>
            {#if candidatesLoading && !candidatesFailed}
              <!-- 候補を読んでいる間は、選択肢が担当なしと今の担当だけなので、まだ読んでいることを示す -->
              <span class="props-note" role="status">{t('loading')}</span>
            {/if}
            {#if candidatesFailed}
              <span class="props-note" id={assigneeNoteId}
                >{t('assigneeCandidatesFailed', { assignee: t('assignee') })}</span
              >
              <button
                class="btn is-sm is-quiet"
                type="button"
                aria-disabled={candidatesLoading}
                onclick={() => void retryCandidates()}
              >
                {candidatesLoading ? t('retrying') : t('retry')}
              </button>
            {/if}
          {:else}
            <span
              >{task.assignee === null
                ? t('unassigned')
                : `${task.assignee.name}${task.assignee.left ? t('leftMember') : ''}`}</span
            >
          {/if}
          {#if done}
            <span class="props-note"
              ><Icon name="lock" />{t('taskAssigneeLocked', {
                task: t('task'),
                done: t('done'),
                assignee: t('assignee'),
              })}</span
            >
          {/if}
          {#if assigneeError !== null}
            <span class="field-error" id={assigneeErrorId} role="alert"><Icon name="alert" />{assigneeError}</span>
          {/if}
        </dd>
      </div>
      <div>
        <dt id={pointsLabelId}>{t('points')}</dt>
        <dd>
          <div
            class="segmented"
            class:is-readonly={!pointsEditable}
            role="radiogroup"
            aria-labelledby={pointsLabelId}
            aria-describedby={[
              done ? pointsReasonId : !canWrite ? readOnlyId : null,
              pointsError !== null ? pointsErrorId : null,
            ]
              .filter((id) => id !== null)
              .join(' ') || undefined}
          >
            {#each pointChoices as choice (choice)}
              <label>
                <input
                  type="radio"
                  name="{ids}-points"
                  value={choice}
                  checked={pointsShown === choice}
                  disabled={!pointsEditable}
                  onchange={() => choosePoints(choice)}
                  aria-label={choice === null ? t('pointsUnsetTitle') : undefined}
                />
                <span>{choice === null ? t('pointsUnsetMark') : choice}</span>
              </label>
            {/each}
          </div>
          {#if done}
            <span class="props-note" id={pointsReasonId}
              ><Icon name="lock" />{t('taskPointsLocked', {
                task: t('task'),
                done: t('done'),
                points: t('points'),
              })}</span
            >
          {/if}
          {#if pointsError !== null}
            <span class="field-error" id={pointsErrorId} role="alert"><Icon name="alert" />{pointsError}</span>
          {/if}
        </dd>
      </div>
      <div>
        <dt>
          {#if canWrite}<label for={dueId}>{t('due')}</label>{:else}{t('due')}{/if}
        </dt>
        <dd>
          {#if canWrite}
            <input
              class="input"
              id={dueId}
              type="date"
              bind:this={dueInput}
              onchange={onDueChange}
              onblur={onDueBlur}
              onkeydown={onDueKeydown}
              aria-invalid={dueError !== null}
              aria-describedby={dueError !== null ? dueErrorId : undefined}
            />
            {#if task.due_on !== null}
              <button class="link-btn" type="button" onclick={clearDue}>{t('dueClear')}</button>
            {/if}
          {:else}
            <!-- 読み取り専用では、入力欄にせず文字で出す（空は「—」） -->
            <span id={dueId}>{task.due_on ?? '—'}</span>
          {/if}
          <!-- 期限の印（木の行と同じ部品）。保存した値（task.due_on）で出し直す。完了したタスクは色なし -->
          {#if task.due_on !== null && clock !== null}
            <DueChip dueOn={task.due_on} today={clock.today} weekStart={clock.weekStart} {done} />
          {/if}
          {#if dueError !== null}
            <span class="field-error" id={dueErrorId} role="alert"><Icon name="alert" />{dueError}</span>
          {/if}
        </dd>
      </div>
      {#if !task.is_imported}
        <div>
          <dt>{t('fieldLink')}</dt>
          <dd>
            {#if canWrite}
              <InlineEdit
                value={task.link_url ?? ''}
                label={t('fieldLink')}
                labelHidden
                inputType="url"
                placeholder={t('linkPlaceholder')}
                problem={linkProblemMessage}
                save={saveLink}
                normalize={linkForm}
                ondirty={(value) => (dirty.link = value)}
              >
                {#snippet view(begin)}
                  <button class="edit-trigger" class:is-empty={task?.link_url === null} type="button" onclick={begin}>
                    {#if task?.link_url != null}
                      <span class="source-key"><Icon name="link" /> {task.link_url}</span>
                    {:else}
                      <span>{t('linkAdd')}</span>
                    {/if}
                    <Icon name="pen" />
                    <span class="visually-hidden">{t('linkEditHint')}</span>
                  </button>
                  {#if task?.link_url != null}
                    <!-- 外のサイトは新しいタブで開く。読み上げにも、新しいタブで開くことを含める。直している間は、読む形ごと隠れる -->
                    <a
                      class="btn is-sm"
                      href={task.link_url}
                      target="_blank"
                      rel="external noopener noreferrer"
                      aria-label={t('storyLinkOpenLabel')}>{t('storyLinkOpen')}</a
                    >
                  {/if}
                {/snippet}
              </InlineEdit>
            {:else if task.link_url !== null}
              <span class="source-key"><Icon name="link" /> {task.link_url}</span>
              <a
                class="btn is-sm"
                href={task.link_url}
                target="_blank"
                rel="external noopener noreferrer"
                aria-label={t('storyLinkOpenLabel')}>{t('storyLinkOpen')}</a
              >
            {:else}
              —
            {/if}
          </dd>
        </div>
      {/if}
    </dl>

    <div class="field">
      {#if canWrite}
        <InlineEdit
          value={task.body_md ?? ''}
          label={t('fieldBody')}
          multiline
          hint={t('bodyEditHint')}
          problem={bodyProblem}
          save={saveBody}
          normalize={(raw) => normalizeLongText(raw) ?? ''}
          ondirty={(value) => (dirty.body = value)}
        >
          {#snippet view(begin)}
            <div class="field-head">
              <span class="field-label">{t('fieldBody')}</span>
              <button class="btn is-sm" type="button" onclick={begin}><Icon name="pen" />{t('editBody')}</button>
            </div>
            {@render bodyView()}
          {/snippet}
        </InlineEdit>
      {:else}
        <span class="field-label">{t('fieldBody')}</span>
        {@render bodyView()}
      {/if}
    </div>

    <!-- 変更の履歴（kit.js の drawerHtml の .history）。コメント（#171）が入ったら、見本どおりのタブにする -->
    <section
      class="field"
      aria-labelledby={historyHeadingId}
      aria-busy={historyState === 'loading' || historyReloading}
    >
      <h3 class="field-label" id={historyHeadingId} tabindex="-1" bind:this={historyHeading}>{t('historyTitle')}</h3>
      <!-- 読み込みの進み具合と、足した件数の読み上げの領域。常に置き、中の文字だけを替える -->
      <span class="visually-hidden" role="status">{historyStatus}</span>
      {#if historyState === 'loading'}
        <p class="field-hint" aria-hidden="true">{t('loading')}</p>
      {:else if historyState === 'failed'}
        <!-- 読み直している間も、失敗の表示とボタンを残す（ボタンは押せなくし、読み直していることを示す） -->
        <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{t('historyLoadFailed')}</span></div>
        <div class="form-actions">
          <button class="btn is-sm" type="button" aria-disabled={historyReloading} onclick={retryHistory}>
            {historyReloading ? t('retrying') : t('retry')}
          </button>
        </div>
      {:else}
        {#if historyReloadFailed}
          <!-- 保存した後の読み直しに失敗した。前に読めた行は残し、上に失敗と「もう一度試す」を添える -->
          <div class="form-actions">
            <span class="field-error" role="alert"><Icon name="alert" />{t('historyReloadFailed')}</span>
            <button class="btn is-sm is-quiet" type="button" aria-disabled={historyReloading} onclick={retryHistory}>
              {historyReloading ? t('retrying') : t('retry')}
            </button>
          </div>
        {/if}
        <ul class="history">
          {#each historyViews as view (view.id)}
            <li>
              <time class="mono" datetime={view.createdAt}>{view.at}</time>
              {#if view.actor !== null}
                <Avatar userId={view.actor.id} name={view.actorName} decorative />
              {/if}
              <span>{view.actorName}</span>
              <span class="props-note">{view.summary}</span>
              {#if view.lines.length > 0}
                <ul class="history-changes">
                  {#each view.lines as line, index (index)}
                    <li>
                      {#if line.label !== null}<span class="props-note">{line.label}</span>{/if}
                      <span>{line.text}</span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </li>
          {:else}
            <li class="props-note">{t('historyEmpty')}</li>
          {/each}
        </ul>
        {#if historyNext !== null}
          <div class="form-actions">
            <button
              class="btn is-sm"
              type="button"
              aria-disabled={historyMore === 'loading' || historyReloading}
              onclick={() => void showMoreHistory()}
            >
              {historyMore === 'loading' ? t('loading') : t('historyMore')}
            </button>
          </div>
        {/if}
        {#if historyMore === 'failed'}
          <span class="field-error" role="alert"><Icon name="alert" />{t('historyMoreFailed')}</span>
        {/if}
      {/if}
    </section>

    {#if canWrite}
      <div class="form-actions">
        {#if task.can_delete}
          <button
            class="btn is-sm is-quiet is-danger"
            type="button"
            aria-disabled={deleting}
            onclick={(event) => void remove(event)}
          >
            <Icon name="trash" />{t('taskDelete', { task: t('task') })}
          </button>
        {:else if task.is_imported}
          <span class="field-hint">{t('taskImportedNoDelete', { task: t('task'), archive: t('archive') })}</span>
        {:else}
          <span class="field-hint">{t('taskDeleteWho', { leader: t('leader') })}</span>
        {/if}
      </div>
      {#if deleteError !== null}
        <div class="callout is-danger" role="alert"><Icon name="alert" /><span>{deleteError}</span></div>
      {/if}
    {/if}
  {/if}

  <!-- 状態の読み上げの領域。常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{status}</span>
</Drawer>

<ConfirmDialog
  bind:this={discardDialog}
  title={t('discardTitle')}
  confirmLabel={t('discardConfirm')}
  cancelLabel={t('discardKeep')}
  danger
>
  <p>{t('discardText')}</p>
</ConfirmDialog>

<ConfirmDialog
  bind:this={deleteDialog}
  title={t('taskDeleteTitle', { task: t('task') })}
  confirmLabel={t('taskDeleteConfirm')}
  cancelLabel={t('taskDeleteCancel')}
  danger
>
  <p>{t('taskDeleteText', { title: task?.title ?? '' })}</p>
  <p class="field-hint">{t('taskDeleteHint')}</p>
</ConfirmDialog>
