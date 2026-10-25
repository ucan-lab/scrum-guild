import { flushSync } from 'svelte';
import { describe, expect, test } from 'vitest';
import type { MarkdownBlock } from './markdown.ts';
import type { FrameClock } from './markdown-render.ts';
import type { MarkdownLoader, MarkdownResult } from './markdown-session.ts';
import { bindMarkdownView } from './markdown-view.svelte.ts';

const paragraph = (value: string): MarkdownBlock[] => [{ type: 'paragraph', children: [{ type: 'text', value }] }];
// 段階の描画に回る長さの本文（重みが単一回の上限を超える）
const longBody = (count = 3000): MarkdownBlock[] =>
  Array.from({ length: count }, (_, i) => ({ type: 'paragraph', children: [{ type: 'text', value: `p${i}` }] }));

// 結果を自分で返す偽のローダー
function fakeLoader(known: Record<string, MarkdownResult> = {}) {
  const loads: { source: string; cancelled: boolean; resolve: (result: MarkdownResult) => void }[] = [];
  const loader: MarkdownLoader = {
    recall: (source) => (source in known ? { result: known[source] } : undefined),
    load(source) {
      let resolve!: (result: MarkdownResult) => void;
      const result = new Promise<MarkdownResult>((r) => (resolve = r));
      const load = { source, cancelled: false, resolve };
      loads.push(load);
      return {
        result,
        cancel: () => {
          load.cancelled = true;
        },
      };
    },
  };
  return { loader, loads };
}

// フレームを自分で走らせる偽の時計。now は呼ぶたびに10ms進む（1フレームに描く量が、数回で予算に尽きる）
function fakeClock() {
  let time = 0;
  let nextId = 1;
  const frames = new Map<number, () => void>();
  const cancelled: number[] = [];
  const clock: FrameClock = {
    now: () => (time += 10),
    requestFrame: (callback) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => {
      cancelled.push(id);
      frames.delete(id);
    },
  };
  return {
    clock,
    frames,
    cancelled,
    runFrame() {
      const [id, callback] = [...frames][0] ?? [];
      if (id === undefined || !callback) return false;
      frames.delete(id);
      callback();
      return true;
    },
  };
}

// 非同期の then を流す
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// 部品の外で、効果の根（$effect.root）の中で配線を作る。source は部品の props に当たる
function mountView(loader: MarkdownLoader, initial: string, clock?: FrameClock) {
  const props = $state({ source: initial });
  let bound!: ReturnType<typeof bindMarkdownView>;
  const stop = $effect.root(() => {
    bound = bindMarkdownView(() => props.source, loader, clock);
  });
  flushSync();
  return {
    props,
    stop,
    get view() {
      return bound.view;
    },
  };
}

describe('bindMarkdownView（Markdown.svelte の配線）', () => {
  test('mount したら表示を頼み、結果が来たら描く', async () => {
    const { loader, loads } = fakeLoader();
    const mounted = mountView(loader, 'a');
    expect(loads.map((l) => l.source)).toEqual(['a']);
    expect(mounted.view).toEqual({ status: 'loading', blocks: null, rendering: false });

    loads[0].resolve(paragraph('a'));
    await flush();
    expect(mounted.view).toEqual({ status: 'ready', blocks: paragraph('a'), rendering: false });
    mounted.stop();
  });

  test('source が変わったら、前の要求を取り下げて頼み直し、結果が来るまで前の描画を残す', async () => {
    const { loader, loads } = fakeLoader();
    const mounted = mountView(loader, 'a');
    loads[0].resolve(paragraph('a'));
    await flush();

    mounted.props.source = 'b';
    flushSync();
    expect(loads.map((l) => l.source)).toEqual(['a', 'b']);
    expect(mounted.view).toEqual({ status: 'loading', blocks: paragraph('a'), rendering: false });

    loads[1].resolve(paragraph('b'));
    await flush();
    expect(mounted.view).toEqual({ status: 'ready', blocks: paragraph('b'), rendering: false });
    mounted.stop();
  });

  test('source が入れ替わったら、古い要求は取り下げ、その結果は捨てる', async () => {
    const { loader, loads } = fakeLoader();
    const mounted = mountView(loader, 'a');
    mounted.props.source = 'b';
    flushSync();
    expect(loads[0].cancelled).toBe(true);

    loads[0].resolve(paragraph('a'));
    await flush();
    expect(mounted.view.status).toBe('loading');
    loads[1].resolve(paragraph('b'));
    await flush();
    expect(mounted.view).toEqual({ status: 'ready', blocks: paragraph('b'), rendering: false });
    mounted.stop();
  });

  test('部品が消えたら待ちを取り下げ、遅れて届いた結果は捨てる', async () => {
    const { loader, loads } = fakeLoader();
    const mounted = mountView(loader, 'a');
    mounted.stop();
    expect(loads[0].cancelled).toBe(true);

    loads[0].resolve(paragraph('a'));
    await flush();
    expect(mounted.view).toEqual({ status: 'loading', blocks: null, rendering: false });
  });

  test('覚えた結果は、頼まずに同じ手番で描く', () => {
    const { loader, loads } = fakeLoader({ a: paragraph('a') });
    const mounted = mountView(loader, 'a');
    expect(mounted.view).toEqual({ status: 'ready', blocks: paragraph('a'), rendering: false });
    expect(loads).toHaveLength(0);
    mounted.stop();
  });

  test('覚えている時間切れの本文は、頼まずに plain で出す', () => {
    const { loader, loads } = fakeLoader({ slow: null });
    const mounted = mountView(loader, 'slow');
    expect(mounted.view).toEqual({ status: 'plain', blocks: null, rendering: false });
    expect(loads).toHaveLength(0);
    mounted.stop();
  });
});

describe('bindMarkdownView の段階の描画', () => {
  test('長い本文は、先頭の一部だけを描き、フレームごとに増やして、描き終わるまで rendering', async () => {
    const body = longBody();
    const { loader, loads } = fakeLoader();
    const timeline = fakeClock();
    const mounted = mountView(loader, 'long', timeline.clock);
    loads[0].resolve(body);
    await flush();

    expect(mounted.view.status).toBe('ready');
    expect(mounted.view.rendering).toBe(true);
    const first = mounted.view.blocks?.length ?? 0;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(body.length);
    // 描いてある節は、本文の先頭から
    expect(mounted.view.blocks).toEqual(body.slice(0, first));

    let last = first;
    while (timeline.runFrame()) {
      const count = mounted.view.blocks?.length ?? 0;
      expect(count).toBeGreaterThanOrEqual(last);
      last = count;
    }
    expect(mounted.view).toEqual({ status: 'ready', blocks: body, rendering: false });
    mounted.stop();
  });

  test('短い本文は、フレームを待たず1回で全部描く（rendering にならない）', async () => {
    const body = longBody(20);
    const { loader, loads } = fakeLoader();
    const timeline = fakeClock();
    const mounted = mountView(loader, 'short', timeline.clock);
    loads[0].resolve(body);
    await flush();
    expect(mounted.view).toEqual({ status: 'ready', blocks: body, rendering: false });
    expect(timeline.frames.size).toBe(0);
    mounted.stop();
  });

  test('描きかけの途中で source が変わったら、続きを描かず、描いてある分を残して待つ', async () => {
    const body = longBody();
    const { loader, loads } = fakeLoader();
    const timeline = fakeClock();
    const mounted = mountView(loader, 'long', timeline.clock);
    loads[0].resolve(body);
    await flush();
    timeline.runFrame();
    const drawn = mounted.view.blocks;
    expect(mounted.view.rendering).toBe(true);

    mounted.props.source = 'next';
    flushSync();
    expect(timeline.frames.size).toBe(0);
    expect(timeline.cancelled).toHaveLength(1);
    expect(timeline.runFrame()).toBe(false);
    expect(mounted.view).toEqual({ status: 'loading', blocks: drawn, rendering: false });

    // 次の本文は、先頭から描き直す
    loads[1].resolve(longBody(4000));
    await flush();
    expect(mounted.view.status).toBe('ready');
    expect(mounted.view.rendering).toBe(true);
    expect(mounted.view.blocks?.[0]).toEqual(longBody(1)[0]);
    mounted.stop();
  });

  test('部品が消えたら、予約したフレームを取り消す', async () => {
    const { loader, loads } = fakeLoader();
    const timeline = fakeClock();
    const mounted = mountView(loader, 'long', timeline.clock);
    loads[0].resolve(longBody());
    await flush();
    expect(timeline.frames.size).toBe(1);

    mounted.stop();
    expect(timeline.frames.size).toBe(0);
    expect(timeline.cancelled).toHaveLength(1);
  });
});
