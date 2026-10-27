// 設定の並べ替えられる一覧（区分とリポジトリ）の行のドラッグの配線。バックログの木（backlog-dnd.svelte.ts）の一覧版で、
// 行は同じ一覧の中で動かすだけなので、判定は list-drop.ts の insertAround だけで足りる。
// scope は一覧の名前で、別の一覧の行は受け付けない。enabled が偽の間（送っている間）は、つかめない
import { autoScrollWindowForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { attachInstruction, extractInstruction } from '@atlaskit/pragmatic-drag-and-drop-hitbox/list-item';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { ElementDragPayload } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { insertAround, type Insertion } from './list-drop.ts';

const FLASH_MS = 900;

type Cleanup = () => void;

export type ListMove = Insertion & { id: string };

export type ListDndOptions = {
  scope: string;
  // 今の並び（行の ID）
  ids: () => readonly string[];
  enabled: () => boolean;
  onDrop: (move: ListMove) => void;
};

type Mark = { id: string; edge: 'before' | 'after' };

export class ListDnd {
  readonly #options: ListDndOptions;
  // つかんでいる行
  dragging = $state<string | null>(null);
  // 落とす位置の印
  mark = $state<Mark | null>(null);
  // 落として、光らせている行
  flashed = $state<string | null>(null);
  #flashTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ListDndOptions) {
    this.#options = options;
  }

  markOf(id: string): 'before' | 'after' | undefined {
    return this.mark?.id === id ? this.mark.edge : undefined;
  }

  flash(id: string): void {
    clearTimeout(this.#flashTimer);
    this.flashed = id;
    this.#flashTimer = setTimeout(() => (this.flashed = null), FLASH_MS);
  }

  #sourceOf(source: ElementDragPayload): string | null {
    const { type, id } = source.data;
    return type === this.#options.scope && typeof id === 'string' ? id : null;
  }

  handle(id: string) {
    return (node: HTMLElement): Cleanup =>
      draggable({
        element: node,
        canDrag: () => this.#options.enabled(),
        getInitialData: () => ({ type: this.#options.scope, id }),
        onGenerateDragPreview: ({ nativeSetDragImage, location }) => {
          const row = node.closest<HTMLElement>('li');
          if (row === null || nativeSetDragImage === null) return;
          const box = row.getBoundingClientRect();
          nativeSetDragImage(row, location.initial.input.clientX - box.left, location.initial.input.clientY - box.top);
        },
      });
  }

  target(id: string) {
    return (node: HTMLElement): Cleanup =>
      dropTargetForElements({
        element: node,
        canDrop: ({ source }) => this.#sourceOf(source) !== null,
        getData: ({ input, element }) =>
          attachInstruction(
            { id },
            { input, element, operations: { 'reorder-before': 'available', 'reorder-after': 'available' } },
          ),
      });
  }

  monitor(): Cleanup {
    const resolve = (source: ElementDragPayload, targets: readonly { data: Record<string | symbol, unknown> }[]) => {
      const sourceId = this.#sourceOf(source);
      const target = targets[0];
      if (sourceId === null || target === undefined) return null;
      const operation = extractInstruction(target.data)?.operation;
      if (operation !== 'reorder-before' && operation !== 'reorder-after') return null;
      const targetId = target.data.id as string;
      const edge = operation === 'reorder-before' ? 'before' : 'after';
      const insertion = insertAround(this.#options.ids(), sourceId, targetId, edge);
      return insertion === null
        ? null
        : { mark: { id: targetId, edge } satisfies Mark, move: { ...insertion, id: sourceId } };
    };
    const show = (mark: Mark | null) => {
      if (mark?.id !== this.mark?.id || mark?.edge !== this.mark?.edge) this.mark = mark;
    };
    return combine(
      monitorForElements({
        canMonitor: ({ source }) => this.#sourceOf(source) !== null,
        onDragStart: ({ source }) => {
          this.dragging = this.#sourceOf(source);
          this.mark = null;
        },
        onDrag: ({ source, location }) => show(resolve(source, location.current.dropTargets)?.mark ?? null),
        onDropTargetChange: ({ source, location }) => show(resolve(source, location.current.dropTargets)?.mark ?? null),
        onDrop: ({ source, location }) => {
          const resolved = resolve(source, location.current.dropTargets);
          this.dragging = null;
          this.mark = null;
          if (resolved !== null) this.#options.onDrop(resolved.move);
        },
      }),
      autoScrollWindowForElements({ canScroll: ({ source }) => this.#sourceOf(source) !== null }),
    );
  }
}
