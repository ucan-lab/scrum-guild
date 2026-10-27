// 画面のエラーを送る側（client-error-report.ts、Issue #376）を崩しにいくテスト。
// client-error-report.test.ts が確かめていない手口だけを置く
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

describe('Promise の拒否の stack の先頭のフレーム', () => {
  // 根拠: Issue の「着手前に詰めたこと」の「スタック」は、Promise の拒否は stack の先頭のフレームから場所を取ると決めた。
  // Safari（JavaScriptCore）は、モジュールの最上位と大域のコードのフレームを `module code@URL:行:列`、`global code@URL:行:列`
  // と空白を含む名前で書く。AT_SIGN_FRAME が名前に空白を許さないので先頭のフレームを読み飛ばし、2つ目のフレーム
  // （別の場所）か null を送る
  test.each(['module code', 'global code'])('Safari の %s@URL:行:列 も先頭のフレームとして読む', (frameName) => {
    const { reporter, sent } = setup();
    const reason = new Error('boom');
    reason.stack = [
      `${frameName}@${ORIGIN}/_app/immutable/entry/app.js:3:15`,
      `@${ORIGIN}/_app/immutable/chunks/other.js:9:9`,
    ].join('\n');
    reporter.onRejection(rejectionEvent(reason));
    expect(sent[0]?.location).toEqual({ file: '/_app/immutable/entry/app.js', line: 3, column: 15 });
  });
});
