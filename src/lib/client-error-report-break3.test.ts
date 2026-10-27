// 画面のエラーを送る側（client-error-report.ts、Issue #376）を崩しにいくテストの3周目。
// client-error-report.test.ts、client-error-report-break.test.ts、client-error-report-break2.test.ts が確かめていない手口だけを置く
import { describe, expect, test } from 'vitest';
import { CLIENT_ERROR_MAX_BODY_BYTES, type ClientErrorReport } from '../shared/client-error.ts';
import { createClientErrorReporter } from './client-error-report.ts';

const ORIGIN = 'https://scrum-guild.example.test';

const rejectionEvent = (reason: unknown): PromiseRejectionEvent => ({ reason }) as unknown as PromiseRejectionEvent;

describe('画面が送る本文の大きさと、サーバーの上限（4KiB）', () => {
  // 根拠: 受け入れ条件「捕まえていない例外か Promise の拒否が起きると、Workers Logs に…1行が残る」。
  // Issue の「着手前に詰めたこと」は、画面が message を 1,000 字（UTF-16 の単位）に切って送り、サーバーは 4KiB を超える本文を
  // 413 で断る（ログを出さない）と決めた。JSON.stringify は制御文字（\b \f \n \r \t を除く U+0000〜U+001F）を \u0000 の
  // 6バイトに書くので、制御文字を含む message は 1,000 字でも 4KiB を超え、画面が送った本文がサーバーに断られてエラーが残らない。
  // バイナリの応答を text() で読んでそのまま Error の message にする（`throw new Error(await res.text())`）と、NUL などの制御文字が入る。
  // 送る処理はやり直さない（Issue の「画面での間引き」）ので、このエラーはどこにも残らない
  test('制御文字を含む 1,000 字の message でも、送る本文は 4KiB に収まる', () => {
    const sent: ClientErrorReport[] = [];
    const reporter = createClientErrorReporter({
      send: (report) => void sent.push(report),
      version: 'client-sha-376',
      routeId: () => '/[slug]/w/[id]/plan',
      origin: ORIGIN,
    });
    // バイナリの本文を TextDecoder で読んだ文字列（NUL と U+0001 の並び）
    const binaryText = new TextDecoder().decode(new Uint8Array(2000).map((_, i) => i % 2));
    const reason = new Error(binaryText);
    reason.stack = `Error\n    at run (${ORIGIN}/_app/immutable/chunks/abc.js:5:6)`;
    reporter.onRejection(rejectionEvent(reason));
    expect(sent).toHaveLength(1);
    // installClientErrorReporter が fetch に渡す本文と同じ形
    const bytes = new TextEncoder().encode(JSON.stringify(sent[0])).byteLength;
    expect(bytes).toBeLessThanOrEqual(CLIENT_ERROR_MAX_BODY_BYTES);
  });
});
