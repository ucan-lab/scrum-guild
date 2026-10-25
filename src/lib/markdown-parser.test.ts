import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MarkdownBlock } from './markdown.ts';
import {
  createMarkdownParser,
  MARKDOWN_START_TIMEOUT_MS,
  MARKDOWN_TIMEOUT_MS,
  type MarkdownMessage,
  type MarkdownRequest,
  type MarkdownWorker,
} from './markdown-parser.ts';

// 応答を自分で返す偽の Worker。起動（ready）も、結果も、返さなければ返らない
class FakeWorker implements MarkdownWorker {
  static created: FakeWorker[] = [];
  requests: MarkdownRequest[] = [];
  terminated = false;
  onmessage: ((event: { data: MarkdownMessage }) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor() {
    FakeWorker.created.push(this);
  }
  postMessage(request: MarkdownRequest) {
    this.requests.push(request);
  }
  terminate() {
    this.terminated = true;
  }
  ready() {
    this.onmessage?.({ data: { type: 'ready' } });
  }
  reply(id: number, blocks: MarkdownBlock[] | null) {
    this.onmessage?.({ data: { type: 'result', id, blocks } });
  }
}

const paragraph = (value: string): MarkdownBlock[] => [{ type: 'paragraph', children: [{ type: 'text', value }] }];

beforeEach(() => {
  FakeWorker.created = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const newParser = () => createMarkdownParser({ createWorker: () => new FakeWorker() });

// 起動を済ませた Worker で、1本目の要求を送らせる
function startedParser() {
  const parser = newParser();
  const request = parser.parse('first');
  const [worker] = FakeWorker.created;
  worker.ready();
  return { parser, request, worker };
}

describe('createMarkdownParser', () => {
  test('Worker の起動（ready）を待ってから、要求を送る', async () => {
    const request = newParser().parse('a');
    const [worker] = FakeWorker.created;
    expect(worker.requests).toEqual([]);
    worker.ready();
    expect(worker.requests).toEqual([{ id: 0, source: 'a' }]);
    worker.reply(0, paragraph('a'));
    await expect(request.result).resolves.toEqual(paragraph('a'));
    expect(worker.terminated).toBe(false);
  });

  test('起動に時間がかかっても、変換の時間切れには数えない', async () => {
    const request = newParser().parse('a');
    const [worker] = FakeWorker.created;
    vi.advanceTimersByTime(MARKDOWN_START_TIMEOUT_MS - 1);
    worker.ready();
    vi.advanceTimersByTime(MARKDOWN_TIMEOUT_MS - 1);
    expect(worker.terminated).toBe(false);
    worker.reply(0, paragraph('a'));
    await expect(request.result).resolves.toEqual(paragraph('a'));
  });

  test('起動が終わらなければ、null を返して Worker を止め、以後は Worker を作らない', async () => {
    const parser = newParser();
    const request = parser.parse('a');
    vi.advanceTimersByTime(MARKDOWN_START_TIMEOUT_MS);
    await expect(request.result).resolves.toBeNull();
    expect(FakeWorker.created[0].terminated).toBe(true);
    expect(FakeWorker.created[0].requests).toEqual([]);

    await expect(parser.parse('b').result).resolves.toBeNull();
    expect(FakeWorker.created).toHaveLength(1);
  });

  test('起動の前のエラーは、Worker が使えないものとして扱う', async () => {
    const parser = newParser();
    const request = parser.parse('a');
    FakeWorker.created[0].onerror?.(new Error('document is not defined'));
    await expect(request.result).resolves.toBeNull();
    await expect(parser.parse('b').result).resolves.toBeNull();
    expect(FakeWorker.created).toHaveLength(1);
  });

  test('1秒で終わらない本文は null を返し、Worker を止める', async () => {
    const { request, worker } = startedParser();
    vi.advanceTimersByTime(MARKDOWN_TIMEOUT_MS - 1);
    expect(worker.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(request.result).resolves.toBeNull();
    expect(worker.terminated).toBe(true);
  });

  test('時間切れの後の要求は、作り直した Worker の起動を待って変換する', async () => {
    const { parser, request, worker } = startedParser();
    vi.advanceTimersByTime(MARKDOWN_TIMEOUT_MS);
    await request.result;

    const next = parser.parse('next');
    expect(FakeWorker.created).toHaveLength(2);
    const fresh = FakeWorker.created[1];
    expect(fresh).not.toBe(worker);
    expect(fresh.requests).toEqual([]);
    fresh.ready();
    expect(fresh.requests).toEqual([{ id: 1, source: 'next' }]);
    fresh.reply(1, paragraph('next'));
    await expect(next.result).resolves.toEqual(paragraph('next'));
  });

  test('止めた Worker から遅れて届いた応答は、次の要求に混ぜない', async () => {
    const { parser, request, worker: old } = startedParser();
    vi.advanceTimersByTime(MARKDOWN_TIMEOUT_MS);
    await request.result;

    const next = parser.parse('next');
    old.reply(0, paragraph('slow'));
    old.reply(1, paragraph('wrong'));
    const fresh = FakeWorker.created[1];
    fresh.ready();
    fresh.reply(1, paragraph('next'));
    await expect(next.result).resolves.toEqual(paragraph('next'));
  });

  test('要求は1本ずつ送り、時間切れの数え始めは送った時点', async () => {
    const { parser, request, worker } = startedParser();
    const second = parser.parse('second');
    expect(worker.requests.map((r) => r.source)).toEqual(['first']);

    vi.advanceTimersByTime(MARKDOWN_TIMEOUT_MS - 100);
    worker.reply(0, paragraph('first'));
    await request.result;
    expect(worker.requests.map((r) => r.source)).toEqual(['first', 'second']);

    // 2本目は待った時間を数えない
    vi.advanceTimersByTime(MARKDOWN_TIMEOUT_MS - 1);
    expect(worker.terminated).toBe(false);
    worker.reply(1, paragraph('second'));
    await expect(second.result).resolves.toEqual(paragraph('second'));
  });

  test('待っている要求の取り下げは、Worker に送らない', async () => {
    const { parser, worker } = startedParser();
    const second = parser.parse('second');
    const third = parser.parse('third');
    second.cancel();
    await expect(second.result).resolves.toBeNull();
    worker.reply(0, paragraph('first'));
    expect(worker.requests.map((r) => r.source)).toEqual(['first', 'third']);
    worker.reply(2, paragraph('third'));
    await expect(third.result).resolves.toEqual(paragraph('third'));
  });

  test('送り済みの要求の取り下げは、結果を捨てて Worker を止めない', async () => {
    const { request, worker } = startedParser();
    request.cancel();
    worker.reply(0, paragraph('first'));
    await expect(request.result).resolves.toEqual(paragraph('first'));
    expect(worker.terminated).toBe(false);
  });

  test('取り下げは、Worker に送る前なら true、送り済みなら false を返す', async () => {
    const { parser, request, worker } = startedParser();
    const queued = parser.parse('queued');
    expect(queued.cancel()).toBe(true);
    expect(request.cancel()).toBe(false);
    worker.reply(0, paragraph('first'));
    await request.result;
    // 結果が出た後の取り下げは、取り下げではない
    expect(request.cancel()).toBe(false);
  });

  test('大量に待っている状態で起動が失敗しても、再帰せず全件が null で終わる', async () => {
    const parser = newParser();
    const requests = Array.from({ length: 10_000 }, (_, i) => parser.parse(`source ${i}`));
    FakeWorker.created[0].onerror?.(new Error('document is not defined'));
    const results = await Promise.all(requests.map((request) => request.result));
    expect(results.every((result) => result === null)).toBe(true);
    expect(FakeWorker.created).toHaveLength(1);
  });

  test('大量に待っている状態で起動の上限を超えても、全件が null で終わる', async () => {
    const parser = newParser();
    const requests = Array.from({ length: 10_000 }, (_, i) => parser.parse(`source ${i}`));
    vi.advanceTimersByTime(MARKDOWN_START_TIMEOUT_MS);
    const results = await Promise.all(requests.map((request) => request.result));
    expect(results.every((result) => result === null)).toBe(true);
    expect(FakeWorker.created).toHaveLength(1);
  });

  test('起動を待つ間に取り下げられた要求は、送らない', async () => {
    const request = newParser().parse('a');
    expect(request.cancel()).toBe(true);
    FakeWorker.created[0].ready();
    expect(FakeWorker.created[0].requests).toEqual([]);
    await expect(request.result).resolves.toBeNull();
  });

  test('起動の後の Worker のエラーは、今の要求だけ null にして、Worker を作り直す', async () => {
    const { parser, request, worker } = startedParser();
    worker.onerror?.(new Error('boom'));
    await expect(request.result).resolves.toBeNull();
    expect(worker.terminated).toBe(true);

    parser.parse('b');
    expect(FakeWorker.created).toHaveLength(2);
  });

  test('結果を読めなかった（messageerror）要求は null', async () => {
    const { request, worker } = startedParser();
    worker.onmessageerror?.(new Error('DataCloneError'));
    await expect(request.result).resolves.toBeNull();
    expect(worker.terminated).toBe(true);
  });

  test('Worker の中で変換に失敗した、または上限を超えた（blocks が null の）応答は null', async () => {
    const { request, worker } = startedParser();
    worker.reply(0, null);
    await expect(request.result).resolves.toBeNull();
    expect(worker.terminated).toBe(false);
  });

  test('Worker を作れない環境では null を返す', async () => {
    const parser = createMarkdownParser({
      createWorker: () => {
        throw new Error('Worker is not defined');
      },
    });
    await expect(parser.parse('a').result).resolves.toBeNull();
  });

  test('送れなかった要求は null を返す', async () => {
    const parser = createMarkdownParser({
      createWorker: () => {
        const worker = new FakeWorker();
        worker.postMessage = () => {
          throw new Error('DataCloneError');
        };
        return worker;
      },
    });
    const request = parser.parse('a');
    FakeWorker.created[0].ready();
    await expect(request.result).resolves.toBeNull();
  });
});
