import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MarkdownBlock } from './markdown.ts';
import {
  createMarkdownParser,
  MARKDOWN_TIMEOUT_MS,
  type MarkdownRequest,
  type MarkdownResponse,
  type MarkdownWorker,
} from './markdown-parser.ts';

// 応答を自分で返す偽の Worker。返さなければ、変換が終わらない本文になる
class FakeWorker implements MarkdownWorker {
  static created: FakeWorker[] = [];
  requests: MarkdownRequest[] = [];
  terminated = false;
  onmessage: ((event: { data: MarkdownResponse }) => void) | null = null;
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
  reply(id: number, blocks: MarkdownBlock[] | null) {
    this.onmessage?.({ data: { id, blocks } });
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

describe('createMarkdownParser', () => {
  test('Worker の応答の節を返す', async () => {
    const request = newParser().parse('a');
    const [worker] = FakeWorker.created;
    expect(worker.requests).toEqual([{ id: 0, source: 'a' }]);
    worker.reply(0, paragraph('a'));
    await expect(request.result).resolves.toEqual(paragraph('a'));
    expect(worker.terminated).toBe(false);
  });

  test('1秒で終わらない本文は null を返し、Worker を止める', async () => {
    const request = newParser().parse('*_'.repeat(50_000));
    vi.advanceTimersByTime(MARKDOWN_TIMEOUT_MS - 1);
    expect(FakeWorker.created[0].terminated).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(request.result).resolves.toBeNull();
    expect(FakeWorker.created[0].terminated).toBe(true);
  });

  test('時間切れの後の要求は、作り直した Worker で変換する', async () => {
    const parser = newParser();
    const slow = parser.parse('slow');
    vi.advanceTimersByTime(MARKDOWN_TIMEOUT_MS);
    await slow.result;

    const next = parser.parse('next');
    expect(FakeWorker.created).toHaveLength(2);
    const [, fresh] = FakeWorker.created;
    expect(fresh.requests).toEqual([{ id: 1, source: 'next' }]);
    fresh.reply(1, paragraph('next'));
    await expect(next.result).resolves.toEqual(paragraph('next'));
  });

  test('止めた Worker から遅れて届いた応答は、次の要求に混ぜない', async () => {
    const parser = newParser();
    const slow = parser.parse('slow');
    const [old] = FakeWorker.created;
    vi.advanceTimersByTime(MARKDOWN_TIMEOUT_MS);
    await slow.result;

    const next = parser.parse('next');
    old.onmessage?.({ data: { id: 0, blocks: paragraph('slow') } });
    old.reply(1, paragraph('wrong'));
    const [, fresh] = FakeWorker.created;
    fresh.reply(1, paragraph('next'));
    await expect(next.result).resolves.toEqual(paragraph('next'));
  });

  test('要求は1本ずつ送り、時間切れの数え始めは送った時点', async () => {
    const parser = newParser();
    const first = parser.parse('first');
    const second = parser.parse('second');
    const [worker] = FakeWorker.created;
    expect(worker.requests.map((r) => r.source)).toEqual(['first']);

    vi.advanceTimersByTime(MARKDOWN_TIMEOUT_MS - 100);
    worker.reply(0, paragraph('first'));
    await first.result;
    expect(worker.requests.map((r) => r.source)).toEqual(['first', 'second']);

    // 2本目は待った時間を数えない
    vi.advanceTimersByTime(MARKDOWN_TIMEOUT_MS - 1);
    expect(worker.terminated).toBe(false);
    worker.reply(1, paragraph('second'));
    await expect(second.result).resolves.toEqual(paragraph('second'));
  });

  test('待っている要求の取り下げは、Worker に送らない', async () => {
    const parser = newParser();
    parser.parse('first');
    const second = parser.parse('second');
    const third = parser.parse('third');
    second.cancel();
    await expect(second.result).resolves.toBeNull();
    const [worker] = FakeWorker.created;
    worker.reply(0, paragraph('first'));
    expect(worker.requests.map((r) => r.source)).toEqual(['first', 'third']);
    worker.reply(2, paragraph('third'));
    await expect(third.result).resolves.toEqual(paragraph('third'));
  });

  test('送り済みの要求の取り下げは、結果を捨てて Worker を止めない', async () => {
    const parser = newParser();
    const request = parser.parse('a');
    request.cancel();
    FakeWorker.created[0].reply(0, paragraph('a'));
    await expect(request.result).resolves.toEqual(paragraph('a'));
    expect(FakeWorker.created[0].terminated).toBe(false);
  });

  test('Worker のエラーは null を返し、Worker を作り直す', async () => {
    const parser = newParser();
    const failing = parser.parse('a');
    FakeWorker.created[0].onerror?.(new Error('boom'));
    await expect(failing.result).resolves.toBeNull();
    expect(FakeWorker.created[0].terminated).toBe(true);

    parser.parse('b');
    expect(FakeWorker.created).toHaveLength(2);
  });

  test('Worker の中で変換に失敗した（blocks が null の）応答は null', async () => {
    const request = newParser().parse('a');
    FakeWorker.created[0].reply(0, null);
    await expect(request.result).resolves.toBeNull();
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
    await expect(parser.parse('a').result).resolves.toBeNull();
  });
});
