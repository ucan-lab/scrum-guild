import { provideTaskOrder, releaseTaskOrder } from './drawer.svelte.ts';

// 画面に今見えているタスクの行の ID を、画面の上から下の順に返す。引き出しの前後の移動の順になる。
// 行は data-task-id を持つリンクかボタン（TaskEntry、CompletedTasks、SprintCard、計画の行）。ストーリーとエピックの行は持たないので入らない。
// 畳んだ枝（TreeStory、TreeEpic の hidden）の中の行は、DOM には残るが見えないので外す。
// 畳み方の状態は各部品の中にあるので、画面のデータから順を組まず、描かれた結果を読む。同じタスクの行が2つ描かれていれば、先の1つだけを数える
export function visibleTaskIds(root: ParentNode): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const element of root.querySelectorAll('[data-task-id]')) {
    const id = element.getAttribute('data-task-id');
    if (id === null || id === '' || seen.has(id) || element.closest('[hidden]') !== null) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

// 文字や数字を入れる input の型。ブラウザは type 属性が無いか不明な値の input を 'text' として返す（空文字は属性が空のときの保険）。
// radio、checkbox、button、range など文字を打たない型は含めない（ポイントの radio にフォーカスがあっても前後へ移れる）
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  '',
  'text',
  'search',
  'url',
  'email',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
]);

// キー入力の先が、文字を打つ場所か（文字を入れる型の input、textarea、select、contenteditable）。`[` と `]` を打つ人の邪魔をしない
function isTypingTarget(target: unknown): boolean {
  const element = target as { tagName?: string; type?: string; isContentEditable?: boolean } | null;
  if (element === null) return false;
  if (element.isContentEditable === true) return true;
  const tag = element.tagName?.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return tag === 'INPUT' && TEXT_INPUT_TYPES.has((element.type ?? '').toLowerCase());
}

export type StepKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'keyCode' | 'isComposing' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat' | 'defaultPrevented'
> & { target: EventTarget | null };

// `[` が前、`]` が次。入力欄の中、日本語の変換中（keyCode 229 は、isComposing が偽になる Safari の変換確定の直後も含む）、
// 修飾キー付き、押しっぱなしの繰り返し、ほかの処理が受けたキーでは移らない
export function stepOfKey(event: StepKeyEvent): -1 | 1 | null {
  if (event.key !== '[' && event.key !== ']') return null;
  if (event.isComposing || event.keyCode === 229 || event.repeat || event.defaultPrevented) return null;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  if (isTypingTarget(event.target)) return null;
  return event.key === '[' ? -1 : 1;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

// 行の入れ物に付ける（`{@attach trackTaskOrder}`）。付いている間、見えている行の順を引き出しへ渡し、外れたら空へ戻す。
// 行の出入り、並べ替え、畳む／開くを MutationObserver で追う（同じ順のときは渡し直さない）。
// 引き出しを開いていなくても木は変わり続けるので、変化は requestAnimationFrame でまとめ、1フレームに1回だけ全行を走査する
export function trackTaskOrder(root: HTMLElement): () => void {
  const owner = Symbol('task-order');
  let current: readonly string[] = visibleTaskIds(root);
  provideTaskOrder(owner, current);
  let frame: number | null = null;
  const observer = new MutationObserver(() => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const next = visibleTaskIds(root);
      if (sameIds(next, current)) return;
      current = next;
      provideTaskOrder(owner, next);
    });
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden', 'data-task-id'],
  });
  return () => {
    observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    releaseTaskOrder(owner);
  };
}
