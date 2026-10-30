import { SvelteURL } from 'svelte/reactivity';
import { showToast } from './toast.svelte.ts';
import { t } from './vocabulary.svelte.ts';

export const TASK_OPEN_MODE_KEY = 'task-open-mode';
export const taskOpenModes = ['side', 'center', 'page', 'tab'] as const;
export type TaskOpenMode = (typeof taskOpenModes)[number];

function isTaskOpenMode(value: unknown): value is TaskOpenMode {
  return taskOpenModes.includes(value as TaskOpenMode);
}

export function readTaskOpenMode(): TaskOpenMode {
  try {
    const value = localStorage.getItem(TASK_OPEN_MODE_KEY);
    return isTaskOpenMode(value) ? value : 'side';
  } catch {
    return 'side';
  }
}

// 620px 以下は引き出しがもともと全幅になるので、真ん中の見た目が横と変わらない。切り替えにも真ん中を出さないため、横として描く
export function effectiveTaskOpenMode(mode: TaskOpenMode, narrow: boolean): TaskOpenMode {
  return mode === 'center' && narrow ? 'side' : mode;
}

export const drawerState = $state<{ mode: TaskOpenMode }>({ mode: readTaskOpenMode() });

export function setTaskOpenMode(mode: TaskOpenMode): void {
  try {
    localStorage.setItem(TASK_OPEN_MODE_KEY, mode);
    drawerState.mode = mode;
  } catch {
    drawerState.mode = 'side';
  }
}

// 帯で押した形が、今描いている形（effectiveTaskOpenMode 後）と同じなら、移らずに既定だけを保存する。
// 保存済みの既定は描いている形と違いうる（ページ全体や新しいタブの既定のまま `?task=` の横で開いた、狭い幅の真ん中）ので、
// 描いている形と同じ形を押したときも、押した形を既定にする。違う形は、書きかけの確認の後に呼び出し側が保存して移る
export function pickTaskOpenMode(next: TaskOpenMode, shown: TaskOpenMode): 'stay' | 'move' {
  if (next !== shown) return 'move';
  setTaskOpenMode(next);
  return 'stay';
}

// 別のタブで既定を替えたら、開きっぱなしのこのタブにも反映する（storage イベントは、書いたタブ以外に届く）
export function handleTaskOpenModeStorage(event: { key: string | null; newValue: string | null }): void {
  if (event.key === TASK_OPEN_MODE_KEY && isTaskOpenMode(event.newValue)) drawerState.mode = event.newValue;
}

if (typeof window !== 'undefined') window.addEventListener('storage', handleTaskOpenModeStorage);

// 引き出しの「前へ」「次へ」で移る順。開いている画面が、今見えているタスクの行の ID を画面の上から下の順に置く（task-order.ts）。
// 順を置く画面が無いとき（メンバーなど行を持たない画面）は空で、引き出しは前後のボタンを出さない。
// 画面を替えるとき、新しい画面の置き直しが古い画面の片付けより先に走りうるので、置いた持ち主を覚え、持ち主でない片付けは無視する
// 行は数百から数千になりうるので、配列は deep proxy にせず（$state.raw）、置き換えて知らせる。読む側は taskOrder.ids を読む
let orderIds = $state.raw<readonly string[]>([]);
let orderOwner: symbol | null = null;

export const taskOrder = {
  get ids(): readonly string[] {
    return orderIds;
  },
};

export function provideTaskOrder(owner: symbol, ids: readonly string[]): void {
  orderOwner = owner;
  orderIds = ids;
}

export function releaseTaskOrder(owner: symbol): void {
  if (orderOwner !== owner) return;
  orderOwner = null;
  orderIds = [];
}

// 帯の前後のボタン（クリックと Enter）で移ったときだけ、移った先の読み込みの後に、押したのと同じ向きのボタンへフォーカスを戻す。
// 引き出しは移るたびに置き直されるので、向きを次の引き出しへ渡す。`[` `]` のキーで移ったときは渡さない（見出しへ移る）。
// 移れなかったとき（移動が取り消された）に残さないよう、移る側が clear する
export type StepSource = 'button' | 'key';

let stepFocus: -1 | 1 | null = null;

export function markStepFocus(delta: -1 | 1): void {
  stepFocus = delta;
}

export function clearStepFocus(): void {
  stepFocus = null;
}

export function consumeStepFocus(): -1 | 1 | null {
  const delta = stepFocus;
  stepFocus = null;
  return delta;
}

export type AdjacentTasks = { prev: string | null; next: string | null };

// 順の中の current の前後。端では null（そこで止まる）。順に current が無いとき（完了して木から外れた、まだ描かれていない）は、
// 前後を決められないので null を返し、引き出しは前後のボタンを出さない
export function adjacentTaskIds(ids: readonly string[], current: string): AdjacentTasks | null {
  const index = ids.indexOf(current);
  if (index < 0) return null;
  return { prev: ids[index - 1] ?? null, next: ids[index + 1] ?? null };
}

// リンクの通常操作も、修飾キーで別タブに開く操作も、同じ実在する URL を使う。
export function taskDetailHref(href: string): string {
  if (drawerState.mode !== 'page' && drawerState.mode !== 'tab') return href;
  const url = new SvelteURL(href, location.href);
  const id = url.searchParams.get('task');
  const base = url.pathname.match(/^(.*\/w\/[^/]+)/)?.[1];
  return id && base ? `${base}/tasks/${encodeURIComponent(id)}` : href;
}

export function taskPageHref(slug: string, workspaceId: string, taskId: string): string {
  return `/${encodeURIComponent(slug)}/w/${encodeURIComponent(workspaceId)}/tasks/${encodeURIComponent(taskId)}`;
}

// 行のタイトルのリンクに付ける属性。新しいタブの既定だけ別タブで開く。
// 横と真ん中は同じ画面の上に重ねるので一覧のスクロールを保つ。ページ全体は別の画面へ移るので、先頭から読む（保つと一覧の位置が持ち越される）
export function taskLinkAttrs(): Record<string, string> {
  if (drawerState.mode === 'tab') return { target: '_blank', rel: 'noopener noreferrer' };
  if (drawerState.mode === 'page') return {};
  return { 'data-sveltekit-reset': 'false' };
}

// 新しいタブでページ全体を開く。ポップアップの遮断などで開けなかったときは false を返し、トーストで知らせる。
// noopener を渡すと成否を戻り値で見られない（常に null）ので、渡さずに開けてから opener を外す
export function openTaskTab(href: string): boolean {
  const opened = window.open(href, '_blank');
  if (opened === null) {
    showToast(t('drawerTabBlocked'), 'alert');
    return false;
  }
  opened.opener = null;
  return true;
}

// 引き出しから「ページ全体」へ移るときは、履歴を足さずに置き換える。そのとき、ページ全体の「前の履歴」は一覧ではない
// （一覧の前の画面）ので、閉じるときに history.back() で戻れない。ページ全体はこの印を見て、戻り先の URL へ移る
let overlayHandoff = false;

export function markOverlayHandoff(): void {
  overlayHandoff = true;
}

// goto が取り消されるなどでページ全体が開かなかったときに、印を残さない。残ると、次にリンクから来たときの閉じ方が狂う
export function clearOverlayHandoff(): void {
  overlayHandoff = false;
}

export function consumeOverlayHandoff(): boolean {
  const marked = overlayHandoff;
  overlayHandoff = false;
  return marked;
}
