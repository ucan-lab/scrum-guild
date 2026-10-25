import { describe, expect, test } from 'vitest';
import type { MarkdownBlock } from './markdown.ts';
import {
  blockWeight,
  MARKDOWN_FRAME_BUDGET_MS,
  MARKDOWN_PAGE_SIZE,
  MARKDOWN_SINGLE_PASS_WEIGHT,
  pagesOf,
  stageBlocks,
} from './markdown-render.ts';

const paragraph = (value: string): MarkdownBlock => ({ type: 'paragraph', children: [{ type: 'text', value }] });
// 重み2（段落と文字）の節を並べる
const paragraphs = (count: number): MarkdownBlock[] => Array.from({ length: count }, () => paragraph('a'));
const taskList = (count: number): MarkdownBlock => ({
  type: 'list',
  ordered: false,
  start: null,
  tight: true,
  items: Array.from({ length: count }, () => ({ checked: false, children: [paragraph('a')] })),
});
const table = (rows: number): MarkdownBlock => ({
  type: 'table',
  align: [null, null],
  head: [[{ type: 'text', value: 'h' }], [{ type: 'text', value: 'h' }]],
  rows: Array.from({ length: rows }, () => [[{ type: 'text', value: 'c' }], [{ type: 'text', value: 'c' }]]),
});

// 時間とフレームを自分で進める偽の時計
function fakeClock() {
  let time = 0;
  let nextId = 1;
  const frames = new Map<number, () => void>();
  const cancelled: number[] = [];
  return {
    advance: (ms: number) => {
      time += ms;
    },
    clock: {
      now: () => time,
      requestFrame: (callback: () => void) => {
        const id = nextId++;
        frames.set(id, callback);
        return id;
      },
      cancelFrame: (id: number) => {
        cancelled.push(id);
        frames.delete(id);
      },
    },
    frames,
    cancelled,
    // 予約されているフレームを1つ走らせ、フレームの間は16ms進める。走らせたら true
    runFrame() {
      const [id, callback] = [...frames][0] ?? [];
      if (id === undefined || !callback) return false;
      frames.delete(id);
      callback();
      time += 16;
      return true;
    },
  };
}

const weightOf = (blocks: MarkdownBlock[]) => blocks.reduce((sum, block) => sum + blockWeight(block), 0);

// show の記録。新しく描いた分の重みに比例して時間が進む
function recorder(timeline: ReturnType<typeof fakeClock>, msPerWeight: number) {
  const calls: { visible: MarkdownBlock[]; done: boolean; measured: boolean }[] = [];
  let drawn = 0;
  return {
    calls,
    show(visible: MarkdownBlock[], progress: { done: boolean; measured: boolean }) {
      const weight = weightOf(visible);
      timeline.advance((weight - drawn) * msPerWeight);
      drawn = weight;
      calls.push({ visible, ...progress });
    },
  };
}

describe('blockWeight', () => {
  test('節、リストの項目、表のセルを1つずつ数える', () => {
    expect(blockWeight(paragraph('a'))).toBe(2);
    expect(blockWeight({ type: 'rule' })).toBe(1);
    expect(blockWeight(taskList(1))).toBe(1 + 1 + 2);
    expect(blockWeight(table(1))).toBe(1 + (1 + 2 * 2) + (1 + 2 * 2));
    expect(
      blockWeight({
        type: 'quote',
        children: [{ type: 'paragraph', children: [{ type: 'strong', children: [{ type: 'text', value: 'a' }] }] }],
      }),
    ).toBe(1 + 1 + 1 + 1);
  });
});

describe('stageBlocks', () => {
  test('短い本文は、1回で全部描き、フレームを予約しない', () => {
    const timeline = fakeClock();
    const blocks = paragraphs(10);
    const { calls, show } = recorder(timeline, 0.02);
    stageBlocks({ blocks, clock: timeline.clock, show });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ done: true, measured: false });
    expect(calls[0].visible).toBe(blocks);
    expect(timeline.frames.size).toBe(0);
  });

  test('空の本文も、1回で描く', () => {
    const timeline = fakeClock();
    const { calls, show } = recorder(timeline, 0.02);
    stageBlocks({ blocks: [], clock: timeline.clock, show });
    expect(calls).toHaveLength(1);
    expect(calls[0].done).toBe(true);
  });

  test('長い本文は、先頭の一部を描いてから、フレームごとに増やして描き終える', () => {
    const timeline = fakeClock();
    const blocks = paragraphs(MARKDOWN_SINGLE_PASS_WEIGHT); // 重み3000
    const { calls, show } = recorder(timeline, 0.02);
    stageBlocks({ blocks, clock: timeline.clock, show });

    expect(calls[0].measured).toBe(false);
    expect(calls[0].done).toBe(false);
    expect(calls[0].visible.length).toBeGreaterThan(0);
    expect(calls[0].visible.length).toBeLessThan(blocks.length);
    expect(timeline.frames.size).toBe(1);

    while (timeline.runFrame());
    expect(calls.at(-1)?.done).toBe(true);
    expect(calls.at(-1)?.visible).toBe(blocks);
    expect(timeline.frames.size).toBe(0);
    // 描いた節の数は、増える一方で、描き済みの節は先頭から同じ
    const counts = calls.map((call) => call.visible.length);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(calls[1].visible.slice(0, calls[0].visible.length)).toEqual(calls[0].visible);
  });

  test('1フレームで描く時間は、予算に収まる（実測で1回の量を決める）', () => {
    const timeline = fakeClock();
    const blocks = paragraphs(20_000);
    const { calls, show } = recorder(timeline, 0.01);
    stageBlocks({ blocks, clock: timeline.clock, show });

    // フレームの間（16ms）を除いた、フレームの中の時間
    const perFrameMs: number[] = [];
    for (;;) {
      const started = timeline.clock.now();
      if (!timeline.runFrame()) break;
      perFrameMs.push(timeline.clock.now() - started - 16);
    }
    expect(calls.at(-1)?.done).toBe(true);
    // 最初のフレームは、実測が無い見積もりで描く。2フレーム目からは、予算を超えない
    for (const ms of perFrameMs.slice(1)) expect(ms).toBeLessThanOrEqual(MARKDOWN_FRAME_BUDGET_MS);
    expect(perFrameMs.length).toBeGreaterThan(1);
  });

  test('描き済みの量に比例する固定の費用があっても、描き終わる（1回の量が縮み続けない）', () => {
    const timeline = fakeClock();
    const blocks = paragraphs(20_000); // 重み4万
    let drawn = 0;
    let lastCount = 0;
    stageBlocks({
      blocks,
      clock: timeline.clock,
      show: (visible) => {
        const weight = weightOf(visible);
        // 新しく描く分に加えて、描き済みの量に比例する費用（スタイルとレイアウト）が毎回掛かる
        timeline.advance((weight - drawn) * 0.01 + weight * 0.002);
        drawn = weight;
        lastCount = visible.length;
      },
    });
    let frames = 0;
    while (timeline.runFrame() && frames < 1_000) frames++;
    expect(lastCount).toBe(blocks.length);
    expect(frames).toBeLessThan(300);
  });

  test('遅い端末では、1回に描く量を減らす', () => {
    const run = (msPerWeight: number) => {
      const timeline = fakeClock();
      const blocks = paragraphs(20_000);
      const { calls, show } = recorder(timeline, msPerWeight);
      stageBlocks({ blocks, clock: timeline.clock, show });
      while (timeline.runFrame());
      return calls.length;
    };
    expect(run(0.05)).toBeGreaterThan(run(0.005));
  });

  test('項目の多い1つのリストは、項目で区切って描く（先頭から、途中まで）', () => {
    const timeline = fakeClock();
    const list = taskList(5_000);
    const { calls, show } = recorder(timeline, 0.02);
    stageBlocks({ blocks: [list], clock: timeline.clock, show });

    const first = calls[0].visible[0];
    expect(first.type).toBe('list');
    const firstItems = first.type === 'list' ? first.items.length : 0;
    expect(firstItems).toBeGreaterThan(0);
    expect(firstItems).toBeLessThan(5_000);
    expect(calls[0].done).toBe(false);

    while (timeline.runFrame());
    const last = calls.at(-1);
    expect(last?.done).toBe(true);
    expect(last?.visible).toEqual([list]);
    // 項目の数は増える一方で、1回に1つのリストのまま
    const counts = calls.map((call) => (call.visible[0].type === 'list' ? call.visible[0].items.length : -1));
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(calls.every((call) => call.visible.length === 1)).toBe(true);
    // 描き済みの項目は、同じもの（作り直さない）
    const secondList = calls[1].visible[0];
    if (first.type === 'list' && secondList.type === 'list') expect(secondList.items[0]).toBe(first.items[0]);
  });

  test('描き済みの頁は、次の描画でも同じ配列（Svelte が描き直さない）', () => {
    const timeline = fakeClock();
    const list = taskList(5_000);
    const { calls, show } = recorder(timeline, 0.02);
    stageBlocks({ blocks: [list], clock: timeline.clock, show });
    timeline.runFrame();

    const itemsOf = (call: (typeof calls)[number]) => {
      const block = call.visible[0];
      return block.type === 'list' ? block.items : [];
    };
    const [before, after] = [itemsOf(calls[0]), itemsOf(calls[1])];
    expect(after.length).toBeGreaterThan(before.length);
    const firstPages = pagesOf(before);
    const nextPages = pagesOf(after);
    expect(firstPages.length).toBeGreaterThan(1);
    // 最後の1頁を除いて、同じ配列
    for (let p = 0; p < firstPages.length - 1; p++) expect(nextPages[p]).toBe(firstPages[p]);
    expect(nextPages.flat()).toEqual(after);
    expect(firstPages.every((page) => page.length <= MARKDOWN_PAGE_SIZE)).toBe(true);
  });

  test('行の多い表は、見出しと最初の行から、行で区切って描く', () => {
    const timeline = fakeClock();
    const wide = table(5_000);
    const { calls, show } = recorder(timeline, 0.02);
    stageBlocks({ blocks: [wide], clock: timeline.clock, show });

    const first = calls[0].visible[0];
    expect(first.type === 'table' && first.rows.length).toBeGreaterThan(0);
    expect(first.type === 'table' && first.head).toEqual(wide.type === 'table' ? wide.head : []);

    while (timeline.runFrame());
    expect(calls.at(-1)?.visible).toEqual([wide]);
  });

  test('リストの後ろの節は、リストを描き終えてから描く', () => {
    const timeline = fakeClock();
    const blocks = [taskList(2_000), paragraph('after')];
    const { calls, show } = recorder(timeline, 0.02);
    stageBlocks({ blocks, clock: timeline.clock, show });
    while (timeline.runFrame());

    for (const call of calls) {
      if (call.visible.length === 2) {
        const list = call.visible[0];
        expect(list.type === 'list' && list.items.length).toBe(2_000);
      }
    }
    expect(calls.at(-1)?.visible).toBe(blocks);
  });

  test('大きな節が入れ子の中にあるだけなら、区切れず1回で描く', () => {
    const timeline = fakeClock();
    const big: MarkdownBlock = { type: 'quote', children: [taskList(MARKDOWN_SINGLE_PASS_WEIGHT)] };
    const { calls, show } = recorder(timeline, 0.02);
    stageBlocks({ blocks: [big], clock: timeline.clock, show });
    expect(calls).toHaveLength(1);
    expect(calls[0].done).toBe(true);
    expect(timeline.frames.size).toBe(0);
  });

  test('取り下げると、予約したフレームを取り消し、続きを描かない', () => {
    const timeline = fakeClock();
    const blocks = paragraphs(5_000);
    const { calls, show } = recorder(timeline, 0.02);
    const staged = stageBlocks({ blocks, clock: timeline.clock, show });
    timeline.runFrame();
    const before = calls.length;
    expect(timeline.frames.size).toBe(1);

    staged.cancel();
    expect(timeline.frames.size).toBe(0);
    expect(timeline.cancelled).toHaveLength(1);
    expect(timeline.runFrame()).toBe(false);
    expect(calls).toHaveLength(before);
    expect(calls.at(-1)?.done).toBe(false);
  });

  test('フレームの中で取り下げても、続きを描かない', () => {
    const timeline = fakeClock();
    const blocks = paragraphs(5_000);
    const calls: number[] = [];
    // 最初の show（measured が偽）は、stageBlocks が戻る前に呼ばれる。取り下げるのは、フレームの中の show
    const staged = stageBlocks({
      blocks,
      clock: timeline.clock,
      show: (visible, { measured }) => {
        calls.push(visible.length);
        timeline.advance(1);
        if (measured) staged.cancel();
      },
    });
    timeline.runFrame();
    const after = calls.length;
    expect(timeline.runFrame()).toBe(false);
    expect(calls).toHaveLength(after);
  });
});
