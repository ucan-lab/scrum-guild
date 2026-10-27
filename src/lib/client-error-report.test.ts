// 画面で捕まえていない例外と Promise の拒否を送る形と間引き（client-error-report.ts、Issue #376）
import { afterEach, describe, expect, test, vi } from 'vitest';
import { clientErrorReportSchema, type ClientErrorReport } from '../shared/client-error.ts';
import { createClientErrorReporter } from './client-error-report.ts';

const ORIGIN = 'https://scrum-guild.example.test';
const CHUNK = `${ORIGIN}/_app/immutable/chunks/abc.js`;

type ErrorEventLike = { message: string; filename: string; lineno: number; colno: number; error: unknown };

const errorEvent = (overrides: Partial<ErrorEventLike> = {}): ErrorEvent => {
  const error = new TypeError("Cannot read properties of undefined (reading 'title')");
  return {
    message: error.message,
    filename: `${CHUNK}?v=1`,
    lineno: 1,
    colno: 2345,
    error,
    ...overrides,
  } as unknown as ErrorEvent;
};

const rejectionEvent = (reason: unknown): PromiseRejectionEvent => ({ reason }) as unknown as PromiseRejectionEvent;

function setup(
  options: { routeId?: () => string | null; send?: (report: ClientErrorReport) => void | Promise<void> } = {},
) {
  const sent: ClientErrorReport[] = [];
  const send = vi.fn(options.send ?? ((report: ClientErrorReport) => void sent.push(report)));
  const reporter = createClientErrorReporter({
    send,
    version: 'client-sha-376',
    routeId: options.routeId ?? (() => '/[slug]/w/[id]/plan'),
    origin: ORIGIN,
  });
  return { reporter, send, sent };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('error イベントから送る形', () => {
  test('種類、名前、メッセージ、場所（オリジンとクエリを落とした /_app/ の下のパス）、route.id、版だけを送る', () => {
    const { reporter, sent } = setup();
    reporter.onError(errorEvent());
    expect(sent).toEqual([
      {
        kind: 'error',
        name: 'TypeError',
        message: "Cannot read properties of undefined (reading 'title')",
        location: { file: '/_app/immutable/chunks/abc.js', line: 1, column: 2345 },
        route: '/[slug]/w/[id]/plan',
        clientVersion: 'client-sha-376',
      },
    ]);
    expect(clientErrorReportSchema.safeParse(sent[0]).success).toBe(true);
  });

  test.each([
    ['別のオリジン', 'https://cdn.example.test/_app/immutable/chunks/abc.js'],
    ['同じオリジンの /_app/ の外', `${ORIGIN}/static/legacy.js`],
    ['拡張機能', 'chrome-extension://abcdef/content.js'],
  ])('%sのファイルは external にする', (_label, filename) => {
    const { reporter, sent } = setup();
    reporter.onError(errorEvent({ filename }));
    expect(sent[0]?.location).toEqual({ file: 'external', line: 1, column: 2345 });
  });

  test('error が Error でなければ、名前は Error、メッセージはイベントの message', () => {
    const { reporter, sent } = setup();
    reporter.onError(errorEvent({ error: null, message: 'Script error.' }));
    expect(sent[0]).toMatchObject({ kind: 'error', name: 'Error', message: 'Script error.' });
    expect(clientErrorReportSchema.safeParse(sent[0]).success).toBe(true);
  });

  test('メッセージは1,000字に切って送る', () => {
    const { reporter, sent } = setup();
    const long = 'x'.repeat(5000);
    reporter.onError(errorEvent({ error: new Error(long), message: long }));
    expect(sent[0]?.message).toBe('x'.repeat(1000));
    expect(clientErrorReportSchema.safeParse(sent[0]).success).toBe(true);
  });

  test('route は起きたときの routeId() の値。当たらない経路は null', () => {
    let route: string | null = '/login';
    const { reporter, sent } = setup({ routeId: () => route });
    reporter.onError(errorEvent({ error: new Error('first'), message: 'first' }));
    route = null;
    reporter.onError(errorEvent({ error: new Error('second'), message: 'second' }));
    expect(sent.map((report) => report.route)).toEqual(['/login', null]);
  });
});

describe('unhandledrejection イベントから送る形', () => {
  test('Error の拒否は、stack の先頭のフレーム（V8 の書き方）から場所を取る', () => {
    const { reporter, sent } = setup();
    const reason = new TypeError('boom');
    reason.stack = [
      'TypeError: boom',
      `    at loadPlan (${ORIGIN}/_app/immutable/nodes/3.B-x_9.js?token=secret:12:34)`,
      `    at ${ORIGIN}/_app/immutable/chunks/other.js:56:78`,
    ].join('\n');
    reporter.onRejection(rejectionEvent(reason));
    expect(sent).toEqual([
      {
        kind: 'unhandledrejection',
        name: 'TypeError',
        message: 'boom',
        location: { file: '/_app/immutable/nodes/3.B-x_9.js', line: 12, column: 34 },
        route: '/[slug]/w/[id]/plan',
        clientVersion: 'client-sha-376',
      },
    ]);
    expect(JSON.stringify(sent)).not.toContain('loadPlan');
    expect(JSON.stringify(sent)).not.toContain('secret');
  });

  test('Firefox と Safari の書き方（関数名@URL:行:列）の先頭のフレームからも場所を取る', () => {
    const { reporter, sent } = setup();
    const reason = new Error('boom');
    reason.stack = [`loadPlan@${ORIGIN}/_app/immutable/nodes/3.js:7:8`, `@${ORIGIN}/_app/immutable/x.js:1:1`].join(
      '\n',
    );
    reporter.onRejection(rejectionEvent(reason));
    expect(sent[0]?.location).toEqual({ file: '/_app/immutable/nodes/3.js', line: 7, column: 8 });
  });

  test('先頭のフレームが別のオリジンなら external', () => {
    const { reporter, sent } = setup();
    const reason = new Error('boom');
    reason.stack = ['Error: boom', '    at https://cdn.example.test/lib.js:3:4'].join('\n');
    reporter.onRejection(rejectionEvent(reason));
    expect(sent[0]?.location).toEqual({ file: 'external', line: 3, column: 4 });
  });

  test('フレームの無い stack は場所が null', () => {
    const { reporter, sent } = setup();
    const reason = new Error('boom');
    reason.stack = 'Error: boom';
    reporter.onRejection(rejectionEvent(reason));
    expect(sent[0]?.location).toBeNull();
  });

  test('Error でない拒否（文字列）も送る。名前は Error、場所は null', () => {
    const { reporter, sent } = setup();
    reporter.onRejection(rejectionEvent('nope'));
    expect(sent[0]).toMatchObject({ kind: 'unhandledrejection', name: 'Error', message: 'nope', location: null });
    expect(clientErrorReportSchema.safeParse(sent[0]).success).toBe(true);
  });

  test.each([[undefined], [null], [{ code: 1 }], [42]])('Error でない拒否 %j も、形に合う本文で送る', (reason) => {
    const { reporter, sent } = setup();
    reporter.onRejection(rejectionEvent(reason));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'unhandledrejection', location: null });
    expect(clientErrorReportSchema.safeParse(sent[0]).success).toBe(true);
  });

  test('拒否のメッセージも1,000字に切る', () => {
    const { reporter, sent } = setup();
    reporter.onRejection(rejectionEvent(new Error('y'.repeat(3000))));
    expect(sent[0]?.message).toBe('y'.repeat(1000));
  });
});

describe('間引き', () => {
  test('種類、名前、メッセージ、場所が同じものは1回だけ送る', () => {
    const { reporter, send } = setup();
    for (let i = 0; i < 3; i++) reporter.onError(errorEvent());
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('メッセージか場所が違えば、別のエラーとして送る', () => {
    const { reporter, send } = setup();
    reporter.onError(errorEvent());
    reporter.onError(errorEvent({ lineno: 2 }));
    reporter.onError(errorEvent({ error: new TypeError('other'), message: 'other' }));
    expect(send).toHaveBeenCalledTimes(3);
  });

  test('同じメッセージでも、error と unhandledrejection は別に数える', () => {
    const { reporter, send } = setup();
    const reason = new Error('same');
    reason.stack = 'Error: same';
    reporter.onError(errorEvent({ error: new Error('same'), message: 'same', filename: '', lineno: 0, colno: 0 }));
    reporter.onRejection(rejectionEvent(reason));
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('全体でも5件まで', () => {
    const { reporter, send } = setup();
    for (let i = 0; i < 8; i++) {
      reporter.onError(errorEvent({ error: new Error(`error ${i}`), message: `error ${i}` }));
    }
    reporter.onRejection(rejectionEvent(new Error('late')));
    expect(send).toHaveBeenCalledTimes(5);
  });

  test('作り直した（ページを読み直した）送り手は、また送る', () => {
    const first = setup();
    first.reporter.onError(errorEvent());
    const second = setup();
    second.reporter.onError(errorEvent());
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(second.send).toHaveBeenCalledTimes(1);
  });
});

describe('送る処理の失敗を外へ漏らさない', () => {
  test('send が throw しても、onError と onRejection は投げない', () => {
    const { reporter } = setup({
      send: () => {
        throw new Error('network down');
      },
    });
    expect(() => reporter.onError(errorEvent())).not.toThrow();
    expect(() => reporter.onRejection(rejectionEvent(new Error('boom')))).not.toThrow();
  });

  test('send の Promise が拒否されても、捕まえていない拒否にしない', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { reporter, send } = setup({ send: () => Promise.reject(new Error('network down')) });
      reporter.onError(errorEvent());
      reporter.onRejection(rejectionEvent(new Error('boom')));
      expect(send).toHaveBeenCalledTimes(2);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  test('send が失敗しても、やり直さない', async () => {
    const { reporter, send } = setup({ send: () => Promise.reject(new Error('network down')) });
    reporter.onError(errorEvent());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(send).toHaveBeenCalledTimes(1);
  });
});
