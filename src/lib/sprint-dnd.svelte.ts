// スプリントの画面のカードのドラッグの配線（pragmatic-drag-and-drop）。何を落とせるか、どこに印を出すか、何を送るかの判定は
// sprint-drop.ts の純粋な関数が決め、ここはブラウザのドラッグの出来事をそこへ渡し、印の状態を持つだけ。
//
// - つかむ場所はカード全体。card() をカード（article）に付ける（Svelte の attachment。{@attach ...}）と、つかめるカードは draggable に、
//   どのカードも重ねられる先になる。column() を列（.board-col）に付けると、カードの無い所と列の頭も重ねられる先になる
// - 題のリンクは draggable="false"（SprintCard）で、リンクの上からもカードをつかめる。ボタンの上から始めたドラッグは取りやめるので、
//   ボタンは押すだけで動き出さない
// - ネイティブのドラッグ（HTML の draggable）を使うので、指（タッチ）の長押しでも動かせる
// - カードの上半分か下半分か（hitbox の list-item）で before / after を、カードの無い所は列の末尾（into）を選ぶ
// - 画面全体が読み直されたら reset() を呼ぶ。つかんでいるドラッグは取りやめ（離しても何も送らない）、印を捨てる。
//   光らせるカードは残す（読み直した後の列で光らせるため）。動かせなかったときは clearFlash() で消す
// - 端での自動スクロールは auto-scroll のパッケージ。画面全体（縦）と、横に溢れる .board-wrap（wrap()）
import {
  autoScrollForElements,
  autoScrollWindowForElements,
} from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { attachInstruction, extractInstruction } from '@atlaskit/pragmatic-drag-and-drop-hitbox/list-item';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { ElementDragPayload } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { SprintBoardColumn } from '../shared/operations/sprint/index.ts';
import { DropFlash } from './drop-flash.svelte.ts';
import {
  gapAbove,
  isGrabbable,
  resolveSprintDrop,
  type SprintDrop,
  type SprintDropMark,
  type SprintDropOperation,
  type SprintDropTarget,
} from './sprint-drop.ts';

const SOURCE_TYPE = 'sprint-card';

type Cleanup = () => void;

export type SprintDndOptions = {
  // 今の列とカードの並び（画面で動かした並びを含む）。ドラッグの出来事のたびに読む
  columns: () => readonly SprintBoardColumn[];
  // つかめるか（書き込めるときだけ）
  enabled: () => boolean;
  // そのカードの完了か戻し（と、続く列の移動）を送っている間か。真の間は、そのカードをつかめない
  busy?: (taskId: string) => boolean;
  // 落とせる場所に落とした
  onDrop: (drop: SprintDrop) => void;
  // 落とせる場所に落としたが、つかんでいる間に画面が読み直されていたので取りやめた
  onStale: () => void;
};

// ボタンの上から始めたドラッグは動かさない。題のリンクは draggable="false" で、リンクの既定のドラッグを止めてあるので、
// リンクの上からもカードをつかめる
const CONTROLS = 'button, input, select, textarea, summary';

function taskIdOf(source: ElementDragPayload): string | null {
  return source.data.type === SOURCE_TYPE && typeof source.data.id === 'string' ? source.data.id : null;
}

export class SprintDnd {
  readonly #options: SprintDndOptions;
  // つかんでいるカード
  taskId = $state<string | null>(null);
  // 落とす位置の印
  mark = $state<SprintDropMark | null>(null);
  // 落として、光らせているカード
  readonly #flashed = new DropFlash<string>();
  // 画面が読み直されるたびに進める。つかんだ時の値と違えば、そのドラッグは取りやめる
  #generation = 0;
  #grabbed = 0;

  constructor(options: SprintDndOptions) {
    this.#options = options;
  }

  // カードに付ける印（data-drop の値）。そのカードが今の落とす位置でなければ undefined
  markOfCard(id: string): 'before' | 'after' | undefined {
    const mark = this.mark;
    if (mark === null || mark.target.kind !== 'card' || mark.target.id !== id) return undefined;
    return mark.operation === 'into' ? undefined : mark.operation;
  }

  // 列に付ける印。その列を囲むときだけ 'into'
  markOfColumn(id: string): 'into' | undefined {
    const mark = this.mark;
    return mark !== null && mark.target.kind === 'column' && mark.target.id === id ? 'into' : undefined;
  }

  isDragging(id: string): boolean {
    return this.taskId === id;
  }

  isFlashing(id: string): boolean {
    return this.#flashed.value === id;
  }

  // 落としたカードを、少しのあいだ光らせる（同じカードを続けて落としても、もう一度光る）
  flash(id: string): void {
    this.#flashed.show(id);
  }

  // 光らせているカードを消す（動かせなかったとき）
  clearFlash(): void {
    this.#flashed.clear();
  }

  // 画面が読み直された。つかんでいるドラッグは取りやめる（離しても何も送らない）。
  // 光らせているカードは消さない — 完了の列へ落としたり戻したりしたカードは、読み直した後の列で光らせるため
  reset(): void {
    this.#generation++;
    this.taskId = null;
    this.mark = null;
  }

  // 画面を読み直したとき（source の値が変わったとき）に reset() を呼ぶ。部品の初期化の中で呼ぶ（$effect.pre を張る）
  resetWhenChanged(source: () => unknown): void {
    $effect.pre(() => {
      void source();
      this.reset();
    });
  }

  // つかめるか。書き込めて、つかめるカード（sprint-drop.ts の isGrabbable）で、完了か戻しを送っている最中でないとき
  canGrab(taskId: string): boolean {
    if (!this.#options.enabled() || this.#options.busy?.(taskId) === true) return false;
    return isGrabbable(this.#options.columns(), taskId);
  }

  // 以下の grab / hover / release は、ドラッグの出来事の受け口。monitor() が呼び、hover と release には判定の結果
  // （SprintDrop。落とせない場所は null）を渡す。つかんでから画面が読み直されていたら、そのドラッグは取りやめる。
  // grab: つかんだ
  grab(taskId: string | null): void {
    this.taskId = taskId;
    this.mark = null;
    this.#grabbed = this.#generation;
  }

  // hover: 重ねている（取りやめたドラッグには印を出さない）
  hover(drop: SprintDrop | null): void {
    this.#show(this.#grabbed === this.#generation ? drop : null);
  }

  // release: 離した（取りやめたドラッグは、落とせる場所でも onStale を呼ぶだけで送らない）
  release(drop: SprintDrop | null): void {
    const stale = this.#grabbed !== this.#generation;
    this.taskId = null;
    this.mark = null;
    if (drop === null) return;
    if (stale) this.#options.onStale();
    else this.#options.onDrop(drop);
  }

  // カード（article）。grabbable が真なら、カード全体をつかめる（draggable）。どのカードも、重ねられる先
  card(id: string, grabbable: boolean) {
    return (node: HTMLElement): Cleanup => {
      const target = dropTargetForElements({
        element: node,
        canDrop: ({ source }) => taskIdOf(source) !== null,
        getData: ({ input, element }) =>
          attachInstruction({ kind: 'card', id } satisfies SprintDropTarget, {
            input,
            element,
            operations: { 'reorder-before': 'available', 'reorder-after': 'available' },
          }),
      });
      if (!grabbable) return target;
      return combine(
        draggable({
          element: node,
          // ボタンやリンクを押すつもりで動き出さない。始めた所の下の要素で見分ける
          canDrag: ({ input }) => {
            if (!this.canGrab(id)) return false;
            const under = document.elementFromPoint(input.clientX, input.clientY);
            const control = under?.closest(CONTROLS);
            return control === null || control === undefined || !node.contains(control);
          },
          getInitialData: () => ({ type: SOURCE_TYPE, id }),
        }),
        target,
      );
    };
  }

  // 列（.board-col）。カードの無い所と列の頭に重ねると、列の末尾に入る。
  // ただし、カードとカードの間の隙間に重ねたときは、上のカードの後ろ（after）の線として扱い、列の囲みに切り替えない
  column(id: string) {
    return (node: HTMLElement): Cleanup =>
      dropTargetForElements({
        element: node,
        canDrop: ({ source }) => taskIdOf(source) !== null,
        getData: ({ input }) => {
          const cards = [...node.querySelectorAll<HTMLElement>('[data-card-id]')].map((card) => {
            const box = card.getBoundingClientRect();
            return { id: card.dataset.cardId ?? '', top: box.top, bottom: box.bottom };
          });
          const gap = gapAbove(cards, input.clientY);
          return gap === null ? { kind: 'column', id } : { kind: 'column', id, gap };
        },
      });
  }

  // 横に溢れる .board-wrap。端に寄せると横へ動く
  wrap(node: HTMLElement): Cleanup {
    return autoScrollForElements({ element: node, canScroll: ({ source }) => taskIdOf(source) !== null });
  }

  // ドラッグの出来事を見張り、印の状態を更新して、落としたら onDrop に渡す。画面を出している間、動かしておく
  monitor(): Cleanup {
    return combine(
      monitorForElements({
        canMonitor: ({ source }) => taskIdOf(source) !== null,
        onDragStart: ({ source }) => this.grab(taskIdOf(source)),
        onDrag: ({ source, location }) => this.hover(this.#resolve(source, location)),
        onDropTargetChange: ({ source, location }) => this.hover(this.#resolve(source, location)),
        onDrop: ({ source, location }) => this.release(this.#resolve(source, location)),
      }),
      autoScrollWindowForElements({ canScroll: ({ source }) => taskIdOf(source) !== null }),
    );
  }

  #resolve(
    source: ElementDragPayload,
    location: { current: { dropTargets: readonly { data: Record<string | symbol, unknown> }[] } },
  ): SprintDrop | null {
    const taskId = taskIdOf(source);
    const hit = location.current.dropTargets[0];
    if (taskId === null || hit === undefined) return null;
    const id = hit.data.id;
    if (typeof id !== 'string') return null;
    if (hit.data.kind === 'column') {
      // カードの間の隙間は、上のカードの後ろ
      const gap = hit.data.gap;
      if (typeof gap === 'string') {
        return resolveSprintDrop(this.#options.columns(), taskId, { kind: 'card', id: gap }, 'after');
      }
      return resolveSprintDrop(this.#options.columns(), taskId, { kind: 'column', id }, 'into');
    }
    if (hit.data.kind !== 'card') return null;
    const operation = extractInstruction(hit.data)?.operation;
    if (operation !== 'reorder-before' && operation !== 'reorder-after') return null;
    const edge: SprintDropOperation = operation === 'reorder-before' ? 'before' : 'after';
    return resolveSprintDrop(this.#options.columns(), taskId, { kind: 'card', id }, edge);
  }

  #show(drop: SprintDrop | null): void {
    const next = drop === null ? null : drop.mark;
    const same =
      next === null || this.mark === null
        ? next === this.mark
        : next.operation === this.mark.operation &&
          next.target.kind === this.mark.target.kind &&
          next.target.id === this.mark.target.id;
    if (!same) this.mark = next;
  }
}
