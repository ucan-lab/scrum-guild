import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MarkdownBlock } from './markdown.ts';
import {
  createMarkdownParser,
  MARKDOWN_TIMEOUT_MS,
  type MarkdownMessage,
  type MarkdownParser,
  type MarkdownRequest,
  type MarkdownWorker,
} from './markdown-parser.ts';
import { createMarkdownLoader, MarkdownSession, type MarkdownView } from './markdown-session.ts';

const paragraph = (value: string): MarkdownBlock[] => [{ type: 'paragraph', children: [{ type: 'text', value }] }];

// 結果を自分で返す偽の parser
function fakeParser() {
  const requests: {
    source: string;
    cancelled: boolean;
    // Worker に送った（テストが立てる）。送る前の取り下げだけが、parser の cancel() で true になる
    sent: boolean;
    resolve: (blocks: MarkdownBlock[] | null) => void;
  }[] = [];
  const parser: MarkdownParser = {
    parse(source) {
      let resolve!: (blocks: MarkdownBlock[] | null) => void;
      const result = new Promise<MarkdownBlock[] | null>((r) => (resolve = r));
      const request = { source, cancelled: false, sent: false, resolve };
      requests.push(request);
      return {
        result,
        cancel: () => {
          request.cancelled = true;
          return !request.sent;
        },
      };
    },
  };
  return { parser, requests };
}

// 非同期の then を流す
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createMarkdownLoader', () => {
  test('成功した結果を覚え、同じ本文は parser に送らない', async () => {
    const { parser, requests } = fakeParser();
    const loader = createMarkdownLoader(parser);
    const first = loader.load('a');
    requests[0].resolve(paragraph('a'));
    await first.result;

    expect(loader.recall('a')).toEqual({ result: paragraph('a') });
    await expect(loader.load('a').result).resolves.toEqual(paragraph('a'));
    expect(requests).toHaveLength(1);
  });

  test('時間切れや失敗（null）も覚え、二度と parser に送らない', async () => {
    const { parser, requests } = fakeParser();
    const loader = createMarkdownLoader(parser);
    const first = loader.load('slow');
    requests[0].resolve(null);
    await first.result;

    expect(loader.recall('slow')).toEqual({ result: null });
    await expect(loader.load('slow').result).resolves.toBeNull();
    expect(requests).toHaveLength(1);
  });

  test('覚えていない本文は undefined', () => {
    expect(createMarkdownLoader(fakeParser().parser).recall('a')).toBeUndefined();
  });

  test('覚える数に上限があり、使っていない本文から捨てる（LRU）', async () => {
    const { parser, requests } = fakeParser();
    const loader = createMarkdownLoader(parser, 2);
    for (const source of ['a', 'b']) {
      const request = loader.load(source);
      requests.at(-1)!.resolve(paragraph(source));
      await request.result;
    }
    // a を使い直すと、捨てられるのは b
    expect(loader.recall('a')).toBeDefined();
    const c = loader.load('c');
    requests.at(-1)!.resolve(paragraph('c'));
    await c.result;

    expect(loader.recall('b')).toBeUndefined();
    expect(loader.recall('a')).toBeDefined();
    expect(loader.recall('c')).toBeDefined();
  });

  test('同じ本文の変換が進んでいるときは、結果を分け合う', async () => {
    const { parser, requests } = fakeParser();
    const loader = createMarkdownLoader(parser);
    const one = loader.load('a');
    const two = loader.load('a');
    expect(requests).toHaveLength(1);
    requests[0].resolve(paragraph('a'));
    await expect(one.result).resolves.toEqual(paragraph('a'));
    await expect(two.result).resolves.toEqual(paragraph('a'));
  });

  test('待つ人が全員取り下げたら parser の要求を取り下げ、その null は覚えない', async () => {
    const { parser, requests } = fakeParser();
    const loader = createMarkdownLoader(parser);
    const one = loader.load('a');
    const two = loader.load('a');
    one.cancel();
    expect(requests[0].cancelled).toBe(false);
    two.cancel();
    expect(requests[0].cancelled).toBe(true);

    requests[0].resolve(null);
    await flush();
    expect(loader.recall('a')).toBeUndefined();

    // 取り下げの後に同じ本文を頼むと、新しく送る
    loader.load('a');
    expect(requests).toHaveLength(2);
  });

  test('Worker に送った後に取り下げても、届いた成功の結果は覚える', async () => {
    const { parser, requests } = fakeParser();
    const loader = createMarkdownLoader(parser);
    const request = loader.load('a');
    requests[0].sent = true;
    request.cancel();
    requests[0].resolve(paragraph('a'));
    await flush();
    expect(loader.recall('a')).toEqual({ result: paragraph('a') });
  });

  test('Worker に送った後に取り下げた本文の時間切れ（null）は覚え、二度と送らない', async () => {
    const { parser, requests } = fakeParser();
    const loader = createMarkdownLoader(parser);
    const request = loader.load('slow');
    requests[0].sent = true;
    request.cancel();
    requests[0].resolve(null);
    await flush();

    expect(loader.recall('slow')).toEqual({ result: null });
    await expect(loader.load('slow').result).resolves.toBeNull();
    expect(requests).toHaveLength(1);
  });

  test('送り済みの要求は、待つ人が全員いなくなっても残し、同じ本文の新しい要求は相乗りする', async () => {
    const { parser, requests } = fakeParser();
    const loader = createMarkdownLoader(parser);
    const first = loader.load('a');
    requests[0].sent = true;
    first.cancel();

    const second = loader.load('a');
    expect(requests).toHaveLength(1);
    requests[0].resolve(paragraph('a'));
    await expect(second.result).resolves.toEqual(paragraph('a'));
  });
});

// 本物の parser とつなぎ、偽の Worker で、送る、取り下げる、時間切れ、もう一度頼む、までを確かめる
describe('createMarkdownLoader と createMarkdownParser', () => {
  class FakeWorker implements MarkdownWorker {
    static created: FakeWorker[] = [];
    requests: MarkdownRequest[] = [];
    onmessage: ((event: { data: MarkdownMessage }) => void) | null = null;
    onmessageerror: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    constructor() {
      FakeWorker.created.push(this);
    }
    postMessage(request: MarkdownRequest) {
      this.requests.push(request);
    }
    terminate() {}
  }

  beforeEach(() => {
    FakeWorker.created = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('送った本文を取り下げて時間切れになっても、同じ本文を二度と送らない', async () => {
    const loader = createMarkdownLoader(createMarkdownParser({ createWorker: () => new FakeWorker() }));
    const request = loader.load('slow');
    const [worker] = FakeWorker.created;
    worker.onmessage?.({ data: { type: 'ready' } });
    expect(worker.requests).toHaveLength(1);

    // 送った後に取り下げ、時間切れを待つ間に同じ本文を頼むと、相乗りする
    request.cancel();
    const again = loader.load('slow');
    expect(worker.requests).toHaveLength(1);
    expect(FakeWorker.created).toHaveLength(1);

    vi.advanceTimersByTime(MARKDOWN_TIMEOUT_MS);
    await expect(again.result).resolves.toBeNull();
    expect(loader.recall('slow')).toEqual({ result: null });

    // 時間切れの後は、新しい Worker にも送らない
    await expect(loader.load('slow').result).resolves.toBeNull();
    expect(FakeWorker.created).toHaveLength(1);
    expect(worker.requests).toHaveLength(1);
  });

  test('送る前に取り下げた本文は、null を覚えず、次に頼まれたら送る', async () => {
    const loader = createMarkdownLoader(createMarkdownParser({ createWorker: () => new FakeWorker() }));
    const first = loader.load('first');
    const second = loader.load('second');
    second.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(loader.recall('second')).toBeUndefined();

    const [worker] = FakeWorker.created;
    worker.onmessage?.({ data: { type: 'ready' } });
    worker.onmessage?.({ data: { type: 'result', id: 0, blocks: paragraph('first') } });
    await first.result;
    loader.load('second');
    expect(worker.requests.map((r) => r.source)).toEqual(['first', 'second']);
  });
});

describe('MarkdownSession', () => {
  function setup() {
    const { parser, requests } = fakeParser();
    const views: MarkdownView[] = [];
    const session = new MarkdownSession(createMarkdownLoader(parser), (view) => views.push(view));
    return { session, requests, views };
  }

  test('結果が来るまでは loading で、来たら ready', async () => {
    const { session, requests } = setup();
    session.show('a');
    expect(session.view).toEqual({ status: 'loading', blocks: null });
    requests[0].resolve(paragraph('a'));
    await flush();
    expect(session.view).toEqual({ status: 'ready', blocks: paragraph('a') });
  });

  test('本文が変わったら、新しい結果が来るまで前の描画を残す', async () => {
    const { session, requests } = setup();
    session.show('a');
    requests[0].resolve(paragraph('a'));
    await flush();

    session.show('b');
    expect(session.view).toEqual({ status: 'loading', blocks: paragraph('a') });
    requests[1].resolve(paragraph('b'));
    await flush();
    expect(session.view).toEqual({ status: 'ready', blocks: paragraph('b') });
  });

  test('本文が入れ替わったら、古い要求の結果は捨てる', async () => {
    const { session, requests } = setup();
    session.show('a');
    session.show('b');
    requests[0].resolve(paragraph('a'));
    await flush();
    expect(session.view.status).toBe('loading');
    requests[1].resolve(paragraph('b'));
    await flush();
    expect(session.view).toEqual({ status: 'ready', blocks: paragraph('b') });
  });

  test('取り下げると待ちを片付け、遅れて届いた結果は捨てる（描いてある節は残す）', async () => {
    const { session, requests, views } = setup();
    session.show('a');
    requests[0].resolve(paragraph('a'));
    await flush();
    session.show('b');
    session.cancel();
    expect(requests[1].cancelled).toBe(true);

    const count = views.length;
    requests[1].resolve(paragraph('b'));
    await flush();
    expect(views).toHaveLength(count);
    expect(session.view.blocks).toEqual(paragraph('a'));
  });

  test('覚えた結果は、parser に送らず同じ手番で描く', async () => {
    const { session, requests } = setup();
    session.show('a');
    requests[0].resolve(paragraph('a'));
    await flush();
    session.show('b');
    requests[1].resolve(paragraph('b'));
    await flush();

    session.show('a');
    expect(session.view).toEqual({ status: 'ready', blocks: paragraph('a') });
    expect(requests).toHaveLength(2);
  });

  test('時間切れの本文は plain で、前の描画は残さない。同じ本文は二度と送らない', async () => {
    const { session, requests } = setup();
    session.show('a');
    requests[0].resolve(paragraph('a'));
    await flush();

    session.show('slow');
    requests[1].resolve(null);
    await flush();
    expect(session.view).toEqual({ status: 'plain', blocks: null });

    session.show('a');
    session.show('slow');
    expect(session.view).toEqual({ status: 'plain', blocks: null });
    expect(requests).toHaveLength(2);
  });

  test('plain の後に新しい本文を待つ間は、描くものが無い（loading で blocks は null）', () => {
    const { session, requests } = setup();
    session.show('slow');
    requests[0].resolve(null);
    return flush().then(() => {
      session.show('b');
      expect(session.view).toEqual({ status: 'loading', blocks: null });
    });
  });
});
