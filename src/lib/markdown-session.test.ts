import { describe, expect, test } from 'vitest';
import type { MarkdownBlock } from './markdown.ts';
import type { MarkdownParser } from './markdown-parser.ts';
import { createMarkdownLoader, MarkdownSession, type MarkdownView } from './markdown-session.ts';

const paragraph = (value: string): MarkdownBlock[] => [{ type: 'paragraph', children: [{ type: 'text', value }] }];

// 結果を自分で返す偽の parser
function fakeParser() {
  const requests: {
    source: string;
    cancelled: boolean;
    resolve: (blocks: MarkdownBlock[] | null) => void;
  }[] = [];
  const parser: MarkdownParser = {
    parse(source) {
      let resolve!: (blocks: MarkdownBlock[] | null) => void;
      const result = new Promise<MarkdownBlock[] | null>((r) => (resolve = r));
      const request = { source, cancelled: false, resolve };
      requests.push(request);
      return {
        result,
        cancel: () => {
          request.cancelled = true;
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

    expect(loader.peek('a')).toEqual({ result: paragraph('a') });
    await expect(loader.load('a').result).resolves.toEqual(paragraph('a'));
    expect(requests).toHaveLength(1);
  });

  test('時間切れや失敗（null）も覚え、二度と parser に送らない', async () => {
    const { parser, requests } = fakeParser();
    const loader = createMarkdownLoader(parser);
    const first = loader.load('slow');
    requests[0].resolve(null);
    await first.result;

    expect(loader.peek('slow')).toEqual({ result: null });
    await expect(loader.load('slow').result).resolves.toBeNull();
    expect(requests).toHaveLength(1);
  });

  test('覚えていない本文は undefined', () => {
    expect(createMarkdownLoader(fakeParser().parser).peek('a')).toBeUndefined();
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
    expect(loader.peek('a')).toBeDefined();
    const c = loader.load('c');
    requests.at(-1)!.resolve(paragraph('c'));
    await c.result;

    expect(loader.peek('b')).toBeUndefined();
    expect(loader.peek('a')).toBeDefined();
    expect(loader.peek('c')).toBeDefined();
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
    expect(loader.peek('a')).toBeUndefined();

    // 取り下げの後に同じ本文を頼むと、新しく送る
    loader.load('a');
    expect(requests).toHaveLength(2);
  });

  test('取り下げた後に届いた成功の結果は覚える', async () => {
    const { parser, requests } = fakeParser();
    const loader = createMarkdownLoader(parser);
    loader.load('a').cancel();
    requests[0].resolve(paragraph('a'));
    await flush();
    expect(loader.peek('a')).toEqual({ result: paragraph('a') });
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
