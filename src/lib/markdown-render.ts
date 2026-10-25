// 変換済みの節を、少しずつ DOM にする。節の数が多い本文を一度に描くと、メインのスレッドが数百 ms から数秒止まる
// （節を DOM にする時間は節の数にほぼ比例する）ので、先頭から、1フレームの時間の予算ごとに増やして描く。
// 区切る単位は、トップレベルの節。ただし、項目や行が多い1つのリストと表（チェックリストと、大きな表）は、項目と行で区切る。
// 時計とフレームの予約は差し込める形にして、時間の進み方をテストで決められるようにしてある。
// 引用の中のリストなど、入れ子の中は区切れない。入れ子の深い1つの節が大きいと、その1つは1フレームで描く
// （節の総量は markdown.ts の MAX_OUTPUT_NODES で抑える）。
import type { MarkdownBlock, MarkdownInline } from './markdown.ts';

// 1フレームで描いてよい時間。60fps の1フレーム（約16ms）より長いが、数十 ms の停止は入力の遅れとして気づかれにくく、
// これより短くすると、描き終わるまでのフレームの数が増えすぎる
export const MARKDOWN_FRAME_BUDGET_MS = 30;

// 重み（節の数の目安）がこれ以下の短い本文は、区切らずに1回で全部描く（ちらつかせない）。
// 手元で測ると、節1000で約15〜30ms なので、1フレームの予算に収まる
export const MARKDOWN_SINGLE_PASS_WEIGHT = 1500;

// 最初の1回に描く重み。実測が無いので、予算に収まる控えめな値にする。2回目からは実測で決める
const INITIAL_CHUNK_WEIGHT = 500;

// 1回に描く重みの下限を、描き済みの重みの割合で持つ。フレームごとにスタイルとレイアウトが、描き済みの量に比例して掛かる
// （script の時間には入らない）ので、実測だけで量を決めると、描くほど1回の量が縮み、描き終わらなくなる
// （予算を12msにして測ると、90秒たっても終わらなかった）。一方、下限を固定の小さな重みにすると、フレームの数が増えて、
// 毎回のレイアウトの合計が増える（重み100で、重み4.8万のチェックリストが2.5秒から15秒になった）。
// 割合なら、フレームの数は描き終わりまで数十で、1回の量は描き済みに比例して増える
const MIN_CHUNK_SHARE = 0.05;

export type FrameClock = {
  now(): number;
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
};

export const browserFrameClock: FrameClock = {
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
};

const inlineWeight = (nodes: MarkdownInline[]): number =>
  nodes.reduce((sum, node) => sum + 1 + ('children' in node ? inlineWeight(node.children) : 0), 0);

type ListBlock = Extract<MarkdownBlock, { type: 'list' }>;
type TableBlock = Extract<MarkdownBlock, { type: 'table' }>;

const listItemWeight = (item: ListBlock['items'][number]): number =>
  1 + item.children.reduce((sum, child) => sum + blockWeight(child), 0);
const tableRowWeight = (row: TableBlock['head']): number =>
  1 + row.reduce((cells, cell) => cells + 1 + inlineWeight(cell), 0);

// 節の数の目安（描く DOM の量）。表のセルと、リストの項目も1つと数える
export function blockWeight(block: MarkdownBlock): number {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
      return 1 + inlineWeight(block.children);
    case 'quote':
      return 1 + block.children.reduce((sum, child) => sum + blockWeight(child), 0);
    case 'list':
      return 1 + block.items.reduce((sum, item) => sum + listItemWeight(item), 0);
    case 'table':
      return 1 + tableRowWeight(block.head) + block.rows.reduce((sum, row) => sum + tableRowWeight(row), 0);
    default:
      return 1;
  }
}

// 頁。Svelte は、配列を描く {#each} を、更新のたびに全部の要素について照らし合わせる。1万項目のリストを増やしながら描くと、
// 1フレームの固定の費用が項目の数に比例して、描き終わらなくなる。そこで、配列を100個ずつの頁に分け、外側の {#each} は頁を、
// 内側の {#each} は頁の中を描く。変わらない頁は同じ配列なので、内側は動かない。頁は配列ごとに覚える
export const MARKDOWN_PAGE_SIZE = 100;

const pageCache = new WeakMap<object, unknown[][]>();

export function pagesOf<T>(items: T[]): T[][] {
  let pages = pageCache.get(items) as T[][] | undefined;
  if (!pages) {
    pages = [];
    for (let i = 0; i < items.length; i += MARKDOWN_PAGE_SIZE) pages.push(items.slice(i, i + MARKDOWN_PAGE_SIZE));
    pageCache.set(items, pages);
  }
  return pages;
}

// 先頭から count 個の配列。頁は、元の配列の頁を使い回す（最後の1頁だけ切り出す）
function prefixOf<T>(items: T[], count: number): T[] {
  if (count >= items.length) return items;
  const full = pagesOf(items);
  const whole = Math.floor(count / MARKDOWN_PAGE_SIZE);
  const rest = count % MARKDOWN_PAGE_SIZE;
  const pages = full.slice(0, whole);
  if (rest > 0) pages.push(full[whole].slice(0, rest));
  const result = items.slice(0, count);
  pageCache.set(result, pages);
  return result;
}

// items の後ろに1つ足した配列。頁は、items の頁を使い回す
function withTail<T>(items: T[], tail: T): T[] {
  const pages = pagesOf(items).slice();
  const last = pages.at(-1);
  if (last && last.length < MARKDOWN_PAGE_SIZE) pages[pages.length - 1] = [...last, tail];
  else pages.push([tail]);
  const result = [...items, tail];
  pageCache.set(result, pages);
  return result;
}

// 描く区切りの単位。block は blocks の添字、part は、その節のうち描く項目か行の数（区切らない節は null）
type Unit = { block: number; part: number | null; weight: number };

function unitsOf(blocks: MarkdownBlock[]): Unit[] {
  const units: Unit[] = [];
  blocks.forEach((block, index) => {
    if (block.type === 'list' && block.items.length > 1) {
      block.items.forEach((item, i) =>
        units.push({ block: index, part: i + 1, weight: listItemWeight(item) + (i === 0 ? 1 : 0) }),
      );
    } else if (block.type === 'table' && block.rows.length > 0) {
      // 見出しの行だけでは表にならないので、見出しと最初の本文の行を最初の単位にする
      block.rows.forEach((row, i) =>
        units.push({
          block: index,
          part: i + 1,
          weight: tableRowWeight(row) + (i === 0 ? 1 + tableRowWeight(block.head) : 0),
        }),
      );
    } else {
      units.push({ block: index, part: null, weight: blockWeight(block) });
    }
  });
  return units;
}

// 先頭から units の count 個までを描くときの節。完了した節はそのまま（描き済みの DOM を作り直さない）、途中の1つだけ切り出す
function visibleBlocks(blocks: MarkdownBlock[], units: Unit[], count: number): MarkdownBlock[] {
  if (count >= units.length) return blocks;
  const last = units[count - 1];
  if (!last) return [];
  const block = blocks[last.block];
  const lastOfBlock = units[count]?.block !== last.block;
  if (lastOfBlock) return prefixOf(blocks, last.block + 1);
  const done = prefixOf(blocks, last.block);
  if (block.type === 'list' && last.part !== null)
    return withTail(done, { ...block, items: prefixOf(block.items, last.part) });
  if (block.type === 'table' && last.part !== null)
    return withTail(done, { ...block, rows: prefixOf(block.rows, last.part) });
  return withTail(done, block);
}

export type StagedRender = { cancel(): void };

// blocks を先頭から少しずつ描かせる（show に、描く節を渡す）。
// measured が真のときの show は、フレームの中で呼ばれ、描画が終わってから戻る（呼び出し側が flushSync する）ので、時間を実測できる。
// 偽のとき（最初の1回）は、描画の予約だけでよい。done が真になったら描き終わり（visible は blocks そのもの）。
// 短い本文は show を1回だけ呼ぶ。cancel は、予約したフレームを取り消して、描きかけで止める
export function stageBlocks(options: {
  blocks: MarkdownBlock[];
  clock: FrameClock;
  show: (visible: MarkdownBlock[], progress: { done: boolean; measured: boolean }) => void;
}): StagedRender {
  const { blocks, clock, show } = options;
  const budgetMs = MARKDOWN_FRAME_BUDGET_MS;
  const units = unitsOf(blocks);
  const total = units.length;
  const totalWeight = units.reduce((sum, unit) => sum + unit.weight, 0);

  let shown = 0;
  let shownWeight = 0;
  let frame: number | null = null;
  let cancelled = false;
  // 重み1あたりの描画の時間（ms）。実測で更新する
  let msPerWeight = budgetMs / INITIAL_CHUNK_WEIGHT;

  // 重みが maxWeight に収まるところまで（最低1つ）単位を進めた数
  function advance(from: number, maxWeight: number): number {
    let next = from;
    let weight = 0;
    while (next < total && (next === from || weight + units[next].weight <= maxWeight)) {
      weight += units[next].weight;
      next++;
    }
    return next;
  }

  function step(maxWeight: number, measured: boolean) {
    const from = shown;
    const to = advance(from, maxWeight);
    const started = clock.now();
    show(visibleBlocks(blocks, units, to), { done: to >= total, measured });
    shown = to;
    let weight = 0;
    for (let i = from; i < to; i++) weight += units[i].weight;
    shownWeight += weight;
    if (measured) {
      const elapsed = clock.now() - started;
      if (elapsed > 0 && weight > 0) msPerWeight = elapsed / weight;
    }
  }

  function onFrame() {
    frame = null;
    if (cancelled) return;
    const started = clock.now();
    do {
      const remaining = budgetMs - (clock.now() - started);
      step(Math.max(1, remaining / msPerWeight, shownWeight * MIN_CHUNK_SHARE), true);
    } while (shown < total && clock.now() - started < budgetMs && !cancelled);
    if (shown < total && !cancelled) frame = clock.requestFrame(onFrame);
  }

  if (totalWeight <= MARKDOWN_SINGLE_PASS_WEIGHT) {
    show(blocks, { done: true, measured: false });
    shown = total;
  } else {
    step(INITIAL_CHUNK_WEIGHT, false);
    if (shown < total) frame = clock.requestFrame(onFrame);
  }

  return {
    cancel() {
      cancelled = true;
      if (frame !== null) clock.cancelFrame(frame);
      frame = null;
    },
  };
}
