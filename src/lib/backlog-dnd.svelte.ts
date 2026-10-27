// バックログの木の行のドラッグの配線（pragmatic-drag-and-drop）。何を落とせるか、どこに印を出すか、何を送るかの判定は
// backlog-drop.ts の純粋な関数が決め、ここはブラウザのドラッグの出来事をそこへ渡し、印の状態を持つだけ。
//
// - 行の先頭のつまみ（.grip）が handle()、重ねられる行が target()。どちらも Svelte の attachment（{@attach ...}）として行に付ける
// - 行の上半分か下半分か（hitbox の list-item）で before / after を、before と after が無い行は into を選ぶ
// - 木が読み直されたら reset() を呼ぶ。つかんでいるドラッグは取りやめ（離しても何も送らない）、印と光らせる行を捨てる
// - 端での自動スクロールは auto-scroll のパッケージ（画面全体）
import { autoScrollWindowForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { attachInstruction, extractInstruction } from '@atlaskit/pragmatic-drag-and-drop-hitbox/list-item';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { ElementDragPayload } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import {
  availableOperations,
  resolveDrop,
  rowKey,
  type DragItem,
  type Drop,
  type DropMark,
  type DropRow,
  type Operation,
  type TreeIndex,
} from './backlog-drop.ts';
import { DropFlash } from './drop-flash.svelte.ts';

const SOURCE_TYPE = 'backlog-row';

type Cleanup = () => void;

export type BacklogDndOptions = {
  // 今の木の並び。ドラッグの出来事のたびに読む
  index: () => TreeIndex;
  // つかめるか（書き込めるときだけ）
  enabled: () => boolean;
  // 落とせる場所に落とした
  onDrop: (drop: Drop) => void;
};

const OPERATIONS = { 'reorder-before': 'before', 'reorder-after': 'after', combine: 'into' } as const;

function itemOf(source: ElementDragPayload): DragItem | null {
  return source.data.type === SOURCE_TYPE ? (source.data.item as DragItem) : null;
}

export class BacklogDnd {
  readonly #options: BacklogDndOptions;
  // つかんでいる行
  item = $state<DragItem | null>(null);
  // 落とす位置の印
  mark = $state<DropMark | null>(null);
  // 落として、光らせている行
  readonly #flashed = new DropFlash<DragItem>();
  // 木が読み直されるたびに進める。つかんだ時の値と違えば、そのドラッグは取りやめる
  #generation = 0;
  #grabbed = 0;

  constructor(options: BacklogDndOptions) {
    this.#options = options;
  }

  // 行に付ける印（data-drop の値）。その行が今の落とす位置でなければ undefined
  markOf(row: DropRow): Operation | undefined {
    const mark = this.mark;
    return mark !== null && rowKey(mark.row) === rowKey(row) ? mark.operation : undefined;
  }

  isDragging(kind: DragItem['kind'], id: string): boolean {
    return this.item?.kind === kind && this.item.id === id;
  }

  isFlashing(kind: DragItem['kind'], id: string): boolean {
    const flashed = this.#flashed.value;
    return flashed?.kind === kind && flashed.id === id;
  }

  // 落とした行を、少しのあいだ光らせる（同じ行を続けて落としても、もう一度光る）
  flash(item: DragItem): void {
    this.#flashed.show(item);
  }

  // 木が読み直された。つかんでいるドラッグは取りやめる（離しても何も送らない）
  reset(): void {
    this.#generation++;
    this.item = null;
    this.mark = null;
    this.#flashed.clear();
  }

  // ドラッグの出来事の受け口。monitor() が呼び、判定の結果（Drop。落とせない場所は null）を渡す。
  // つかんでから木が読み直されていたら、そのドラッグは取りやめる
  grab(item: DragItem | null): void {
    this.item = item;
    this.mark = null;
    this.#grabbed = this.#generation;
  }

  hover(drop: Drop | null): void {
    this.#show(this.#grabbed === this.#generation ? drop : null);
  }

  release(drop: Drop | null): void {
    const stale = this.#grabbed !== this.#generation;
    this.item = null;
    this.mark = null;
    if (drop !== null && !stale) this.#options.onDrop(drop);
  }

  // つまみ（.grip）。つかんだ間は、行全体を見た目の影にする
  handle(item: DragItem) {
    return (node: HTMLElement): Cleanup =>
      draggable({
        element: node,
        canDrag: () => this.#options.enabled(),
        getInitialData: () => ({ type: SOURCE_TYPE, item }),
        onGenerateDragPreview: ({ nativeSetDragImage, location }) => {
          const row = node.closest<HTMLElement>('[data-row-id]');
          if (row === null || nativeSetDragImage === null) return;
          const box = row.getBoundingClientRect();
          nativeSetDragImage(row, location.initial.input.clientX - box.left, location.initial.input.clientY - box.top);
        },
      });
  }

  // 重ねられる行
  target(row: DropRow) {
    return (node: HTMLElement): Cleanup =>
      dropTargetForElements({
        element: node,
        canDrop: ({ source }) => itemOf(source) !== null,
        getData: ({ input, element, source }) => {
          const item = itemOf(source);
          if (item === null) return { row };
          const allowed = availableOperations(this.#options.index(), item, row);
          const availability = (on: boolean) => (on ? 'available' : 'not-available');
          return attachInstruction(
            { row },
            {
              input,
              element,
              operations: {
                'reorder-before': availability(allowed.before),
                'reorder-after': availability(allowed.after),
                combine: availability(allowed.into),
              },
            },
          );
        },
      });
  }

  // ドラッグの出来事を見張り、印の状態を更新して、落としたら onDrop に渡す。画面を出している間、動かしておく
  monitor(): Cleanup {
    return combine(
      monitorForElements({
        canMonitor: ({ source }) => itemOf(source) !== null,
        onDragStart: ({ source }) => this.grab(itemOf(source)),
        onDrag: ({ source, location }) => this.hover(this.#resolve(source, location)),
        onDropTargetChange: ({ source, location }) => this.hover(this.#resolve(source, location)),
        onDrop: ({ source, location }) => this.release(this.#resolve(source, location)),
      }),
      autoScrollWindowForElements({ canScroll: ({ source }) => itemOf(source) !== null }),
    );
  }

  #resolve(
    source: ElementDragPayload,
    location: { current: { dropTargets: readonly { data: Record<string | symbol, unknown> }[] } },
  ): Drop | null {
    const item = itemOf(source);
    const target = location.current.dropTargets[0];
    if (item === null || target === undefined) return null;
    const instruction = extractInstruction(target.data);
    if (instruction === null) return null;
    return resolveDrop(this.#options.index(), item, target.data.row as DropRow, OPERATIONS[instruction.operation]);
  }

  #show(drop: Drop | null): void {
    const next = drop === null ? null : drop.mark;
    const same =
      next === null || this.mark === null
        ? next === this.mark
        : next.operation === this.mark.operation && rowKey(next.row) === rowKey(this.mark.row);
    if (!same) this.mark = next;
  }
}
