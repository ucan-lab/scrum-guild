// 画面のエラーの1行に出す message の伏せ方を、ランタイム（V8）とブラウザが実際に作る message で確かめる
// （POST /api/client-errors、src/server/client-errors.ts の maskClientErrorMessage、Issue #376）。
// 表で確かめる伏せ方は client-errors-format.test.ts
import { describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/server/app.ts';
import { maskClientErrorMessage } from '../src/server/client-errors.ts';
import { CLIENT_ERROR_LOGGED_MESSAGE_LENGTH, CLIENT_ERROR_SENT_MESSAGE_LENGTH } from '../src/shared/client-error.ts';
import { testEnv } from './operations/world.ts';

const app = createApp();
const ORIGIN = new URL(testEnv.PUBLIC_ORIGIN).origin;

// ほかのファイル（192.0.2.0/24、198.51.100.0/24、203.0.113.0/24、198.18.37.6、2001:db8:376c::/48）と
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

// 1件送り、console.error に出た文字列を返す
async function logLineOf(name: string, message: string): Promise<string> {
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
    return String(errorLog.mock.calls[0]?.[0]);
  } finally {
    errorLog.mockRestore();
  }
}

// 1件送り、console.error に出た文字列を返す（名前は SyntaxError）
async function logOf(message: string): Promise<string> {
  return logLineOf('SyntaxError', message);
}

// 1件送り、console.error に出た1行の message を返す
async function loggedMessageOf(name: string, message: string): Promise<string> {
  return (JSON.parse(await logLineOf(name, message)) as { message: string }).message;
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

describe('メッセージの引用符の中身が伏せられずに残る手口', () => {
  // 根拠: 受け入れ条件「1行に本文、入力の値…が入らない」「メッセージの引用符の中…は伏せられる」。
  // V8 の JSON.parse は、読めなかった本文を "…" で囲んで message に入れる（src/server/app.ts の onError の注記も同じことを書く）。
  // 本文の中の " が囲みの " と組になり、本文の値（ここでは pw376）が引用符の外に出て、ログに残る
  test('JSON.parse の失敗（V8 は読めなかった本文を message に含める）で、本文の値がログに出ない', async () => {
    let message = '';
    try {
      JSON.parse('x{"p":"pw376"}');
    } catch (err) {
      message = (err as Error).message;
    }
    // 前提: ランタイムの message が本文を含む（Unexpected token 'x', "x{"p":"pw376"}" is not valid JSON）
    expect(message).toContain('pw376');
    expect(await logOf(message)).not.toContain('pw376');
  });

  // 根拠: 受け入れ条件「メッセージの引用符の中…は伏せられる」。英語の短縮形の ' が、後ろの '…' の開きの ' と組になり、
  // 引用符の中の値が外に出る（Firefox の "can't …" のように、ブラウザのメッセージにも短縮形が入る）
  test("短縮形の ' の後ろにある '…' の中身も伏せる", () => {
    const masked = maskClientErrorMessage("can't save 'secret-title-376' to the server");
    expect(masked).not.toContain('secret-title-376');
  });

  // 根拠: Issue の「着手前に詰めたこと」の「メッセージ」は、画面が 1,000 字に切って送り、サーバーが引用符の中身を伏せると決めた。
  // 画面の切り口が引用符の中にあると、サーバーには閉じていない引用符として届き、元は引用符の中だった値がログに出る
  // （受け入れ条件「メッセージの引用符の中…は伏せられる」に反する）。画面の切り方（slice）は src/lib/client-error-report.ts と同じ
  test('画面が 1,000 字で切ったために閉じなくなった引用符の中身も、ログに出ない', async () => {
    const original = `${'b'.repeat(150)}'${'secret'.repeat(200)}'`;
    const sent = original.slice(0, CLIENT_ERROR_SENT_MESSAGE_LENGTH);
    expect(await logOf(sent)).not.toContain('secret');
  });
});

describe('200字の切り口', () => {
  // 絵文字を含む語は英字だけでない語として伏せる（Issue #376 の「実装中に変えたこと」の手順4）。
  // 伏せた後に切るので、切り口でサロゲートペアの上位だけが残ることはない
  test('切り口でサロゲートペアを割らない（上位だけを残さない）', () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
    const masked = maskClientErrorMessage(`${'a'.repeat(CLIENT_ERROR_LOGGED_MESSAGE_LENGTH - 1)}😀tail`);
    expect(masked).toBe('…');
    expect(masked).not.toMatch(lone);
    const spaced = maskClientErrorMessage(`${'a'.repeat(CLIENT_ERROR_LOGGED_MESSAGE_LENGTH - 2)} 😀tail`);
    expect(spaced).toBe(
      `${'a'.repeat(CLIENT_ERROR_LOGGED_MESSAGE_LENGTH - 2)} …`.slice(0, CLIENT_ERROR_LOGGED_MESSAGE_LENGTH),
    );
    expect(spaced).not.toMatch(lone);
  });
});

// 根拠: 受け入れ条件「1行に…URL のクエリ…トークンが入らない」。ブラウザは、URL を解釈できなかったときや、資格情報の入った URL を
// fetch したときに、その URL を引用符で囲まずに message へ入れる
describe('引用符の外にある URL のクエリと資格情報', () => {
  test.each([
    [
      // Firefox（Gecko）の new URL の失敗。入力をそのまま message に入れる
      'Firefox の new URL',
      'TypeError',
      'URL constructor: https://exa mple.test/cb?token=tok-secret-376 is not a valid URL.',
      'tok-secret-376',
    ],
    [
      // Chrome（Blink）の fetch の失敗。'fetch' と 'Window' は引用符の中だが、URL はその後ろ（最後の ' の外）に出る
      'Chrome の fetch（URL を解釈できない）',
      'TypeError',
      "Failed to execute 'fetch' on 'Window': Failed to parse URL from https://exa mple.test/cb?token=tok-secret-376",
      'tok-secret-376',
    ],
    [
      'Chrome の fetch（資格情報の入った URL）',
      'TypeError',
      "Failed to execute 'fetch' on 'Window': Request cannot be constructed from a URL that includes credentials: https://user:pass-secret-376@example.test/",
      'pass-secret-376',
    ],
    [
      'Firefox の fetch（資格情報の入った URL）',
      'TypeError',
      'Window.fetch: https://user:pass-secret-376@example.test/ is an url with embedded credentials.',
      'pass-secret-376',
    ],
  ])('%s の message から、クエリと資格情報がログに出ない', async (_label, name, message, secret) => {
    expect(await loggedMessageOf(name, message)).not.toContain(secret);
  });
});

// 根拠: 受け入れ条件「1行に本文、入力の値…が入らない」。V8 の RegExp は、作れなかった正規表現の元の文字列を /…/ で囲んで
// message に入れる（Firefox と Safari は入れない）。入力から正規表現を作ったときの失敗で、入力の値が引用符の外に出る。
// 今の画面に入力から正規表現を作るコードは無いが、サーバーは画面を信じない（Issue の「メッセージ」）ので、届いた message で確かめる
describe('引用符でない区切りで囲まれた入力の値', () => {
  test('V8 の RegExp の失敗（/入力/ を message に含める）で、入力の値がログに出ない', async () => {
    // 入力として届いた値（検索の欄などに打たれた文字列）
    const input: string = ['input-secret-376', '('].join('');
    let message = '';
    try {
      new RegExp(input);
    } catch (err) {
      message = (err as Error).message;
    }
    // 前提: ランタイムの message が入力を含む（Invalid regular expression: /input-secret-376(/: Unterminated group）
    expect(message).toContain('input-secret-376');
    expect(await loggedMessageOf('SyntaxError', message)).not.toContain('input-secret-376');
  });
});

// 根拠: 受け入れ条件「1行に本文、入力の値…が入らない」。V8 は、次のエラーで値を引用符で囲まずに message へ入れる
// （引用符は値の前に置いた 'in' やキーの側にだけ付く）。どの message も、このテストを動かすランタイム（workerd の V8。
// Chrome と Edge も同じ V8）が作ったもの
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
// スキームの無い入力（リンクの欄に打たれたメールアドレスや、ただの文字列）は、それだけでは伏せられない
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
