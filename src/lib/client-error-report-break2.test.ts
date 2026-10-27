// 画面のエラーを送る側（client-error-report.ts、Issue #376）を崩しにいくテストの2周目。
// client-error-report.test.ts と client-error-report-break.test.ts が確かめていない手口だけを置く
import { describe, expect, test } from 'vitest';
import type { ClientErrorReport } from '../shared/client-error.ts';
import { createClientErrorReporter } from './client-error-report.ts';

const ORIGIN = 'https://scrum-guild.example.test';

function setup() {
  const sent: ClientErrorReport[] = [];
  const reporter = createClientErrorReporter({
    send: (report) => void sent.push(report),
    version: 'client-sha-376',
    routeId: () => '/login',
    origin: ORIGIN,
  });
  return { reporter, sent };
}

const errorEvent = (filename: string): ErrorEvent =>
  ({ message: 'boom', filename, lineno: 3, colno: 4, error: new Error('boom') }) as unknown as ErrorEvent;

const rejectionEvent = (reason: unknown): PromiseRejectionEvent => ({ reason }) as unknown as PromiseRejectionEvent;

describe('ErrorEvent の filename がオリジンを持たない URL', () => {
  test.each([
    // data: の URL は origin が null。中身（スクリプトの本文）を送らない
    ['data: の URL', 'data:text/javascript,const%20token%3D%22secret-376%22'],
    // blob: の URL は、作ったページのオリジンを origin に持つが、パスは /_app/ の下でない
    ['同じオリジンの blob: の URL', `blob:${ORIGIN}/_app/0190f3e2-0000-7000-8000-000000000376`],
    ['about:blank', 'about:blank'],
  ])('%s は external', (_label, filename) => {
    const { reporter, sent } = setup();
    reporter.onError(errorEvent(filename));
    expect(sent[0]?.location).toEqual({ file: 'external', line: 3, column: 4 });
    expect(JSON.stringify(sent[0])).not.toContain('secret-376');
  });

  test('資格情報の入った同じオリジンの URL は、資格情報を落としたパスにする', () => {
    const { reporter, sent } = setup();
    reporter.onError(errorEvent('https://user:pass-376@scrum-guild.example.test/_app/immutable/chunks/abc.js'));
    expect(sent[0]?.location).toEqual({ file: '/_app/immutable/chunks/abc.js', line: 3, column: 4 });
  });
});

describe('Promise の拒否の stack に出るフレーム', () => {
  test('stack の message の行に @ と :行:列 があっても、関数名や message の中身を file にしない', () => {
    const { reporter, sent } = setup();
    const reason = new Error('mail-secret-376@example.test:1:2');
    reason.stack = `Error: mail-secret-376@example.test:1:2\n    at run (${ORIGIN}/_app/immutable/chunks/abc.js:5:6)`;
    reporter.onRejection(rejectionEvent(reason));
    expect(sent[0]?.location?.file ?? '').not.toContain('mail-secret-376');
  });
});
