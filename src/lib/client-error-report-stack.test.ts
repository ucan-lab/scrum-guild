// 画面のエラーを送る側（client-error-report.ts、Issue #376）が、Promise の拒否の stack から場所を取るときの読み方。
// 場所は先頭のフレームの1か所だけで、関数名と message の中身は送らない
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

const rejectionEvent = (reason: unknown): PromiseRejectionEvent => ({ reason }) as unknown as PromiseRejectionEvent;

describe('Promise の拒否の stack の先頭のフレーム', () => {
  // 根拠: Issue の「着手前に詰めたこと」の「スタック」は、Promise の拒否は stack の先頭のフレームから場所を取ると決めた。
  // Safari（JavaScriptCore）は、モジュールの最上位と大域のコードのフレームを `module code@URL:行:列`、`global code@URL:行:列`
  // と空白を含む名前で書く
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

describe('Promise の拒否の stack に出るフレーム', () => {
  test('stack の message の行に @ と :行:列 があっても、関数名や message の中身を file にしない', () => {
    const { reporter, sent } = setup();
    const reason = new Error('mail-secret-376@example.test:1:2');
    reason.stack = `Error: mail-secret-376@example.test:1:2\n    at run (${ORIGIN}/_app/immutable/chunks/abc.js:5:6)`;
    reporter.onRejection(rejectionEvent(reason));
    expect(sent[0]?.location?.file ?? '').not.toContain('mail-secret-376');
  });

  // V8 の stack は1行目に `<名前>: <message>` を置く。message の `user@host:3:4` が Firefox と Safari の書き方
  // （関数名@URL:行:列）に当たると、message の行を先頭のフレームとして採り、本当の先頭のフレーム（at の行）を読み飛ばす
  test('V8 の書き方（at で始まる行がある）なら、message の行の @…:行:列 を先頭のフレームとして採らない', () => {
    const { reporter, sent } = setup();
    const reason = new Error('user@host:3:4');
    reason.stack = `Error: user@host:3:4\n    at run (${ORIGIN}/_app/immutable/chunks/abc.js:5:6)`;
    reporter.onRejection(rejectionEvent(reason));
    expect(sent[0]?.location).toEqual({ file: '/_app/immutable/chunks/abc.js', line: 5, column: 6 });
  });
});
