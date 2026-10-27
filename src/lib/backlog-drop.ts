// バックログの木のドラッグの判定。つかんだ行（タスクかストーリー）と、重ねた行から、落とせる操作と、落とした結果
// （示す印と、task-move / story-move の入力）を決める。DOM と描画には触れない。
//
// 決まり:
// - タスクの親は、完了していないストーリーか親なし。ストーリーの親は、完了も中止もしていないエピックか親なし。
//   タスクをエピックの直下へ、ストーリーをストーリーの下へは落とせない（何も示さない）。
//   サーバーが断るのは親が変わるときだけなので、今の親の中での並べ替えは、親が完了か中止していても落とせる（ボタンと同じ）
// - 画面で完了にしたタスクは、サーバーが断るので、つかんでも落とせない
// - before / after は行と行の間の線。タスクはタスクの行の前後、ストーリーはストーリーの行の前後に落とす
// - into は親の行を囲む。タスクはストーリーの行、ストーリーはエピックの行に重ねると、その配下の末尾に入る
// - 折りたたみの行と空の案内の行（tail）の前後は、その配下の末尾として扱う
// - 親なしの段が空のときは、つかんでいる間だけ落とし先の行（slot）を出し、into で親なしの末尾に入る
// - 元と同じ位置なら null（何も示さず、何も送らない）
import { insertAround, insertAtEnd, type Insertion } from './list-drop.ts';

// 親なしのタスクと、親のないストーリーの並びのキー。ストーリーとエピックの ID とぶつからない
export const ROOT = '';

export type DragItem = { kind: 'task' | 'story'; id: string };

// 重ねる行。tail は折りたたみの行と空の案内の行で、parent はそれが並ぶ先の親の種類（root は親なしのタスクの折りたたみの行）。
// slot は、親なしの段が空のときだけ出す落とし先（task-root は親なしのタスク、story-root は親のないストーリー）
export type DropRow =
  | { kind: 'task' | 'story' | 'epic'; id: string }
  | { kind: 'tail'; parent: 'story' | 'epic' | 'root'; id: string }
  | { kind: 'slot'; parent: 'task-root' | 'story-root' };

export type Operation = 'before' | 'after' | 'into';

// 木の今の並び（画面で動かした並びを含む）。キーは親の ID か ROOT
export type TreeModel = {
  // 完了も中止もしていないエピックの ID
  openEpics: readonly string[];
  // 親ごとのストーリー。open は完了していないこと
  storyLists: Readonly<Record<string, readonly { id: string; open: boolean }[]>>;
  // 親ごとのタスクの ID
  taskLists: Readonly<Record<string, readonly string[]>>;
  // 画面で完了にしたタスクの ID（読み直すまで行は残る）
  completedTasks: readonly string[];
};

export type TreeIndex = {
  model: TreeModel;
  openEpic: ReadonlySet<string>;
  openStory: ReadonlySet<string>;
  completedTask: ReadonlySet<string>;
  storyParent: ReadonlyMap<string, string>;
  taskParent: ReadonlyMap<string, string>;
  // 親ごとのストーリーの ID（storyLists から id だけ取り出したもの）
  storyIds: Readonly<Record<string, readonly string[]>>;
};

export function indexTree(model: TreeModel): TreeIndex {
  const openStory = new Set<string>();
  const storyParent = new Map<string, string>();
  const storyIds: Record<string, string[]> = {};
  for (const [parent, list] of Object.entries(model.storyLists)) {
    storyIds[parent] = list.map((story) => story.id);
    for (const story of list) {
      storyParent.set(story.id, parent);
      if (story.open) openStory.add(story.id);
    }
  }
  const taskParent = new Map<string, string>();
  for (const [parent, list] of Object.entries(model.taskLists)) {
    for (const id of list) taskParent.set(id, parent);
  }
  return {
    model,
    openEpic: new Set(model.openEpics),
    openStory,
    completedTask: new Set(model.completedTasks),
    storyParent,
    taskParent,
    storyIds,
  };
}

// 行を、ドラッグの印を付ける要素に結ぶ名前
export function rowKey(row: DropRow): string {
  if (row.kind === 'slot') return `slot:${row.parent}`;
  return row.kind === 'tail' ? `tail:${row.parent}:${row.id}` : `${row.kind}:${row.id}`;
}

export type OperationSet = Record<Operation, boolean>;
const NONE: OperationSet = { before: false, after: false, into: false };
const AROUND: OperationSet = { before: true, after: true, into: false };
const INTO: OperationSet = { before: false, after: false, into: true };

// 重ねた行に落とせる操作（位置が今と同じになるかは見ない。それは resolveDrop が決める）。
// 行き先の親が今の親と同じなら、親の状態（完了、中止）は見ない
export function availableOperations(index: TreeIndex, item: DragItem, row: DropRow): OperationSet {
  if (item.kind === 'task') {
    if (index.completedTask.has(item.id)) return NONE;
    const current = index.taskParent.get(item.id);
    // 行き先のストーリー（親なしは ROOT）に落とせるか
    const accepts = (parent: string) => parent === ROOT || parent === current || index.openStory.has(parent);
    switch (row.kind) {
      case 'task': {
        const parent = index.taskParent.get(row.id);
        return parent !== undefined && accepts(parent) ? AROUND : NONE;
      }
      case 'story':
        return accepts(row.id) ? INTO : NONE;
      case 'tail':
        if (row.parent === 'root') return AROUND;
        return row.parent === 'story' && accepts(row.id) ? AROUND : NONE;
      case 'slot':
        return row.parent === 'task-root' ? INTO : NONE;
      default:
        return NONE;
    }
  }
  const current = index.storyParent.get(item.id);
  const accepts = (parent: string) => parent === ROOT || parent === current || index.openEpic.has(parent);
  switch (row.kind) {
    case 'story': {
      const parent = index.storyParent.get(row.id);
      return parent !== undefined && accepts(parent) ? AROUND : NONE;
    }
    case 'epic':
      return accepts(row.id) ? INTO : NONE;
    case 'tail':
      return row.parent === 'epic' && accepts(row.id) ? AROUND : NONE;
    case 'slot':
      return row.parent === 'story-root' ? INTO : NONE;
    default:
      return NONE;
  }
}

export type DropMark = { row: DropRow; operation: Operation };

// task-move / story-move の入力のうち、行き先に当たるもの。afterId が undefined のときは after_*_id を省く（末尾）
export type DropMove = {
  kind: 'task' | 'story';
  id: string;
  // 移す先の親のストーリー（タスク）かエピック（ストーリー）。null は親なし
  parentId: string | null;
  afterId: string | null | undefined;
  // 動かした後の、移す先の中での位置（0 始まり）
  index: number;
  atEnd: boolean;
  // 親が変わるか
  reparent: boolean;
};

export type Drop = { mark: DropMark; move: DropMove };

// つかんだ行を、重ねた行の operation に落としたときの結果。落とせない場所と、元と同じ位置は null
export function resolveDrop(index: TreeIndex, item: DragItem, row: DropRow, operation: Operation): Drop | null {
  if (!availableOperations(index, item, row)[operation]) return null;
  const target = destination(index, item, row, operation);
  if (target === null) return null;
  const current = (item.kind === 'task' ? index.taskParent : index.storyParent).get(item.id);
  const { parent, insertion } = target;
  return {
    mark: { row, operation },
    move: {
      kind: item.kind,
      id: item.id,
      parentId: parent === ROOT ? null : parent,
      afterId: insertion.afterId,
      index: insertion.index,
      atEnd: insertion.atEnd,
      reparent: current !== parent,
    },
  };
}

function destination(
  index: TreeIndex,
  item: DragItem,
  row: DropRow,
  operation: Operation,
): { parent: string; insertion: Insertion } | null {
  const lists = item.kind === 'task' ? index.model.taskLists : index.storyIds;
  const parentOf = item.kind === 'task' ? index.taskParent : index.storyParent;
  // 行の前後（operation が before / after で、行が同じ種類の行）
  if (row.kind === item.kind && operation !== 'into') {
    const parent = parentOf.get(row.id);
    if (parent === undefined) return null;
    const insertion = insertAround(lists[parent] ?? [], item.id, row.id, operation);
    return insertion === null ? null : { parent, insertion };
  }
  // 親の行に重ねる（into）か、折りたたみの行と空の案内の行の前後は、その配下の末尾。slot と親なしの折りたたみの行は、親なしの末尾
  const parent = row.kind === 'slot' || (row.kind === 'tail' && row.parent === 'root') ? ROOT : row.id;
  const insertion = insertAtEnd(lists[parent] ?? [], item.id);
  return insertion === null ? null : { parent, insertion };
}
