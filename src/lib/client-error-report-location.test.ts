// 画面のエラーを送る側（client-error-report.ts、Issue #376）が location.file に入れる値。
// 同じオリジンの /_app/ の下のパスだけを送り、ほかは external にする
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

describe('file に同じオリジンの /_app/ の下以外を入れない', () => {
  test.each([
    ['プロトコルを省いた別のホスト', '//evil.example.test/_app/immutable/chunks/abc.js'],
    ['/_app/ から .. で外へ出るパス', `${ORIGIN}/_app/../api/secret`],
    ['/_app/ から %2e%2e で外へ出るパス', `${ORIGIN}/_app/%2e%2e/api/secret`],
    ['/_app で始まるが /_app/ の下でないパス', `${ORIGIN}/_appx/immutable/chunks/abc.js`],
  ])('%s は external', (_label, filename) => {
    const { reporter, sent } = setup();
    reporter.onError(errorEvent(filename));
    expect(sent[0]?.location).toEqual({ file: 'external', line: 3, column: 4 });
  });
});

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
