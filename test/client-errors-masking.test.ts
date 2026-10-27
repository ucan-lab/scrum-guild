// 画面のエラーを受ける口（POST /api/client-errors、Issue #376）を崩しにいくテストの3周目。
// client-errors.test.ts、client-errors-format.test.ts、client-errors-break.test.ts、client-errors-break2.test.ts が
// 確かめていない手口だけを置く。どれも、ランタイム（V8）が実際に作る message か、ブラウザの実際の文言で確かめる
import { describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { testEnv } from './operations/world.ts';

const app = createApp();
const ORIGIN = new URL(testEnv.PUBLIC_ORIGIN).origin;

// ほかのファイル（192.0.2.0/24、198.51.100.0/24、203.0.113.0/24、198.18.37.6、2001:db8:376b::/48、2001:db8:376c::/48）と
// 重ならない /48 から配る
let ipCount = 0;
const nextIp = () => `2001:db8:376d:${(++ipCount).toString(16)}::1`;

function report(name: string, message: string): Record<string, unknown> {
  return {
    kind: 'unhandledrejection',
    name,
    message,
    location: { file: '/_app/immutable/chunks/abc.js', line: 1, column: 2 },
    route: '/[slug]/w/[id]',
    clientVersion: 'client-sha-376',
  };
}

// 1件送り、console.error に出た1行の message を返す
async function loggedMessageOf(name: string, message: string): Promise<string> {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const res = await app.request(
      '/api/client-errors',
      {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': nextIp() },
        body: JSON.stringify(report(name, message)),
      },
      testEnv,
    );
    expect(res.status).toBe(204);
    expect(errorLog).toHaveBeenCalledTimes(1);
    return (JSON.parse(String(errorLog.mock.calls[0]?.[0])) as { message: string }).message;
  } finally {
    errorLog.mockRestore();
  }
}

// 投げられた例外の message を取る
function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('例外が起きなかった');
}

// 根拠: 受け入れ条件「1行に本文、入力の値…が入らない」。伏せ方は、URL、V8 の正規表現の元の文字列、引用符で囲まれうる範囲、UUID だけ。
// V8 は、次のエラーで値を引用符で囲まずに message へ入れる（引用符は値の前に置いた 'in' やキーの側にだけ付く）。
// 値は引用符の範囲（最初の引用符から最後の引用符まで）の外に出て、そのままログに残る。
// どの message も、このテストを動かすランタイム（workerd の V8。Chrome と Edge も同じ V8）が作ったもの
describe('V8 が値を引用符で囲まずに message へ入れるエラー', () => {
  test.each<[label: string, name: string, run: (value: string) => unknown]>([
    [
      // 画面のコードは API の結果に `'workspace_id' in result.data`（src/lib/components/InvitationInbox.svelte）、
      // `'code' in item`（MemberInvite.svelte）のように in を使う。応答の本文が思った形でなく文字列だと、
      // V8 は `Cannot use 'in' operator to search for 'workspace_id' in <文字列>` と、本文をそのまま入れる
      "in 演算子の右が文字列（Cannot use 'in' operator to search for 'k' in <値>）",
      'TypeError',
      (value) => 'workspace_id' in (value as unknown as object),
    ],
    [
      // 画面のコードは Object.fromEntries と new Map に配列を渡す（src/lib/task-history.ts、src/shared/clock.ts、
      // src/routes/[slug]/w/[id]/+page.svelte）。要素が組でなく文字列だと、V8 は `Iterator value <値> is not an entry object`
      'Object.fromEntries の要素が文字列（Iterator value <値> is not an entry object）',
      'TypeError',
      (value) => Object.fromEntries([value] as unknown as [string, unknown][]),
    ],
    [
      'new Map の要素が文字列（Iterator value <値> is not an entry object）',
      'TypeError',
      (value) => new Map([value] as unknown as [string, unknown][]),
    ],
    [
      // 画面のコードは組織の設定のタイムゾーンで Intl.DateTimeFormat を作る（src/shared/clock.ts の formatterFor は
      // try で囲まない）。ブラウザが知らない値だと、V8 は `Invalid time zone specified: <値>` と、値をそのまま入れる
      'Intl.DateTimeFormat のタイムゾーン（Invalid time zone specified: <値>）',
      'RangeError',
      (value) => new Intl.DateTimeFormat('en-US', { timeZone: value }),
    ],
    [
      // 数字の文字列を BigInt にする失敗。V8 は `Cannot convert <値> to a BigInt`
      'BigInt の変換（Cannot convert <値> to a BigInt）',
      'SyntaxError',
      (value) => BigInt(value),
    ],
  ])('%s', async (_label, name, run) => {
    const value = 'value-secret-376';
    const message = messageOf(() => run(value));
    // 前提: ランタイムの message が値を含む
    expect(message).toContain(value);
    expect(await loggedMessageOf(name, message)).not.toContain(value);
  });
});

// 根拠: 受け入れ条件「1行に…入力の値…が入らない」。Firefox（Gecko）の new URL は、解釈できなかった入力を
// `URL constructor: <入力> is not a valid URL.` と引用符で囲まずに入れる。URL を伏せる正規表現は `スキーム://` を目印にするので、
// スキームの無い入力（リンクの欄に打たれたメールアドレスや、ただの文字列）は伏せられずにログに出る。
// 2周目（client-errors-break2.test.ts）は https:// の付いた入力だけを確かめた
describe('スキームの無い入力を引用符で囲まずに入れるブラウザの文言', () => {
  test.each([
    ['メールアドレス', 'alice.secret-376@example.test'],
    ['ホストだけ', 'secret-376.example.test/path'],
  ])('Firefox の new URL の失敗（%s）', async (_label, input) => {
    expect(await loggedMessageOf('TypeError', `URL constructor: ${input} is not a valid URL.`)).not.toContain(
      'secret-376',
    );
  });
});
