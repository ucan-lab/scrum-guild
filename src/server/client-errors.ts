// 画面で起きた JavaScript のエラーを受け、Workers Logs に1行で残す口（POST /api/client-errors、Issue #376）。
// ログイン前の画面（ログイン、招待）のエラーも拾うため、操作の定義の外に直に書く（docs/development.md の「操作の定義」の例外）。
// 検査の順は Origin → 回数の上限 → 本文を読む（4KiB）→ 形（zod の strict）→ 1行を出す → 204。
// 断ったときはログを出さない。セッションは読まない（D1 のセッションを引かず、誰のエラーかも残さない）。
// 画面が送った値は信じず、メッセージを伏せ、名前、ファイル、経路を決まった形に置き換えてから出す
import { Hono } from 'hono';
import {
  CLIENT_ERROR_LOGGED_MESSAGE_LENGTH,
  CLIENT_ERROR_MAX_BODY_BYTES,
  clientErrorReportSchema,
} from '../shared/client-error.ts';
import { ROUTE_IDS } from '../shared/route-ids.ts';
import type { AppEnv } from './app-env.ts';
import { consumeClientErrorRateLimits } from './auth/rate-limit.ts';
import { ApiError } from './errors.ts';
import { readBodyText, requireOrigin } from './operations/guards.ts';

export type ClientBrowser = {
  family: 'chrome' | 'firefox' | 'safari' | 'edge' | 'other';
  major: number | null;
  mobile: boolean;
};

const KNOWN_ROUTE_IDS: ReadonlySet<string> = new Set(ROUTE_IDS);

export function clientErrorRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    requireOrigin(c);
    if (!(await consumeClientErrorRateLimits(c.env, c.req.header('CF-Connecting-IP'), new Date()))) {
      throw new ApiError(429, 'rate_limited');
    }
    const contentType = c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') throw new ApiError(400, 'invalid_input');
    // 大きすぎる本文は readBodyText が 413 にする
    const text = await readBodyText(c, CLIENT_ERROR_MAX_BODY_BYTES);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(400, 'invalid_input');
    }
    // 誰でも呼べる口なので、どの項目が合わないか（details）は返さない
    const parsed = clientErrorReportSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(400, 'invalid_input');
    const report = parsed.data;

    console.error(
      JSON.stringify({
        level: 'error',
        source: 'client',
        requestId: c.get('requestId'),
        kind: report.kind,
        name: clientErrorName(report.name),
        message: maskClientErrorMessage(report.message),
        location:
          report.location === null
            ? null
            : {
                file: clientErrorFile(report.location.file),
                line: report.location.line,
                column: report.location.column,
              },
        route: report.route !== null && KNOWN_ROUTE_IDS.has(report.route) ? report.route : null,
        clientVersion: clientVersionOf(report.clientVersion),
        version: c.env.APP_VERSION || 'dev',
        browser: browserOf(c.req.header('User-Agent')),
      }),
    );
    return c.body(null, 204);
  });

  return app;
}

const QUOTES = ["'", '"', '`'] as const;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// 引用符で囲まれうる範囲を伏せる。引用符を開きと閉じの対で読むと、入れ子の引用符（JSON.parse が message に入れる本文）、
// 短縮形の '（can't）、画面が切って閉じなくなった引用符で、中身が外に出る。そこで、引用符の種類ごとに、元の文字列で
// 最初に現れた位置から最後に現れた位置までを1つの範囲にし（1つだけなら末尾まで）、3種の範囲を合わせて重なりをまとめてから、
// 範囲ごとに両端の文字の間を … にする。種類ごとに順に置き換えると、先の置き換えが後の種類の引用符を消し、範囲がずれて漏れるため、
// 範囲は置き換える前の文字列で求める。伏せすぎは許す（漏らさないことを先にする）
function maskQuoted(text: string): string {
  const ranges: [start: number, end: number][] = [];
  for (const quote of QUOTES) {
    const first = text.indexOf(quote);
    if (first === -1) continue;
    const last = text.lastIndexOf(quote);
    // 閉じていなければ末尾まで（end は含まない位置）
    ranges.push([first, last === first ? text.length : last + 1]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let result = '';
  let cursor = 0;
  let current: [number, number] | undefined;
  const flush = (range: [number, number]) => {
    const [start, end] = range;
    const closed = end - start >= 2 && QUOTES.some((quote) => quote === text[end - 1]);
    result += text.slice(cursor, start) + text[start] + '…' + (closed ? text[end - 1] : '');
    cursor = end;
  };
  for (const range of ranges) {
    if (current !== undefined && range[0] < current[1]) current[1] = Math.max(current[1], range[1]);
    else {
      if (current !== undefined) flush(current);
      current = [range[0], range[1]];
    }
  }
  if (current !== undefined) flush(current);
  return result + text.slice(cursor);
}

// URL（`スキーム://` から）。ブラウザは解釈できなかった URL や資格情報の入った URL を、引用符で囲まずに message へ入れる。
// 解釈できなかった URL は空白を含みうる（Firefox の `URL constructor: https://exa mple.test/?token=… is not a valid URL.`）ので、
// 空白で区切らず、文字列の末尾までを伏せる。後ろの文言も消えるが、伏せすぎは許す（クエリ、資格情報、トークンを漏らさないことを先にする）
const URL_TO_END = /[a-z][a-z0-9+.-]*:\/\/[\s\S]*$/i;
// V8 の RegExp の失敗（`Invalid regular expression: /<元の文字列>/<フラグ>: <理由>`）。元の文字列は入力から来うるので、
// 最後の `/<フラグ>: ` までを伏せる（元の文字列が / を含んでも漏らさない）。理由の無い形（切れた message）は末尾までを伏せる
const V8_INVALID_REGEXP = /(Invalid regular expression: \/)(?:[\s\S]*(\/[dgimsuvy]*: )|[\s\S]*$)/;

function maskUnquotedInputs(text: string): string {
  return text
    .replace(V8_INVALID_REGEXP, (_all, head: string, tail: string | undefined) => `${head}…${tail ?? ''}`)
    .replace(URL_TO_END, '…');
}

// 値を引用符で囲まずに後ろへ置く区切り（`Invalid time zone specified: <値>`、`Cannot use '…' in <値>`）。
// 最初に現れた区切りの後ろを、末尾まで伏せる
const VALUE_DELIMITERS = [': ', ' in '] as const;

function maskAfterDelimiter(text: string): string {
  const positions = VALUE_DELIMITERS.map((delimiter) => {
    const index = text.indexOf(delimiter);
    return index === -1 ? undefined : index + delimiter.length;
  }).filter((index): index is number => index !== undefined);
  if (positions.length === 0) return text;
  const start = Math.min(...positions);
  return start === text.length ? text : `${text.slice(0, start)}…`;
}

// 語（空白で区切った並び）の前後に付く記号。記号だけの並び（伏せた '…' や括弧）は語として扱わず残す
const WORD_PREFIX = /^['"`([{<…]+/;
const WORD_SUFFIX = /['"`)\]}>…,;:!?.]+$/;

// 英字だけでない語（数字、@、/、.、-、_、英字でない文字を含む語）を … にする。値を区切りも引用符も無しに入れる文言
// （`Iterator value <値> is not an entry object`、`Cannot convert <値> to a BigInt`、スキームの無い URL）の値は、
// 多くが英字でない文字を含むため。英字だけの値は漏れうる（docs/operations.md の「画面のエラー」）
function maskNonAlphabeticWords(text: string): string {
  return text
    .split(/(\s+)/)
    .map((part) => {
      if (part === '' || /^\s+$/.test(part)) return part;
      const prefix = WORD_PREFIX.exec(part)?.[0] ?? '';
      const rest = part.slice(prefix.length);
      const suffix = WORD_SUFFIX.exec(rest)?.[0] ?? '';
      const core = rest.slice(0, rest.length - suffix.length);
      if (core === '' || /^[A-Za-z]+$/.test(core)) return part;
      return `${prefix}…${suffix}`;
    })
    .join('')
    .replace(/…{2,}/g, '…');
}

// 次の順に伏せてから、先頭 200 字にする（切ってから伏せると、200字をまたぐ引用符の中身が漏れる）。伏せすぎは許す
//   1. `スキーム://` から末尾まで、V8 の `Invalid regular expression: /入力/` の入力
//   2. 引用符の種類ごとに、最初から最後まで（1つだけなら末尾まで）
//   3. 「: 」の後ろと「 in 」の後ろを末尾まで
//   4. 英字だけでない語と UUID
export function maskClientErrorMessage(text: string): string {
  const masked = maskNonAlphabeticWords(maskAfterDelimiter(maskQuoted(maskUnquotedInputs(text))).replace(UUID, '…'));
  if (masked.length <= CLIENT_ERROR_LOGGED_MESSAGE_LENGTH) return masked;
  // サロゲートペアの片方だけを残さない
  const end = CLIENT_ERROR_LOGGED_MESSAGE_LENGTH;
  const code = masked.charCodeAt(end - 1);
  return masked.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end);
}

// 画面の版は build のコミットの SHA（e2e は `<SHA>-e2e-<時刻>`、手元は dev）。誰でも送れる文字列なので、形が合わなければ出さない
function clientVersionOf(version: string): string {
  return /^[A-Za-z0-9._-]{1,64}$/.test(version) ? version : 'invalid';
}

export function clientErrorName(name: string): string {
  return /^[A-Za-z]{1,40}$/.test(name) ? name : 'Error';
}

// 同じオリジンの /_app/ の下のパス（画面がオリジンとクエリを落としたもの）でなければ external
export function clientErrorFile(file: string): string {
  return /^\/_app\/[A-Za-z0-9._/-]{1,200}$/.test(file) ? file : 'external';
}

// 長い User-Agent を正規表現に通さない。ブラウザの名前と版は先頭の数百字に入る
const MAX_USER_AGENT_LENGTH = 512;

// User-Agent からブラウザの大まかな種類だけを出す。生の文字列は出さない。
// Edge と Chrome の iOS 版（CriOS）、Firefox の iOS 版（FxiOS）も、それぞれの種類にまとめる
export function browserOf(userAgent: string | undefined): ClientBrowser {
  const ua = (userAgent ?? '').slice(0, MAX_USER_AGENT_LENGTH);
  const mobile = /\bMobile\b|\bAndroid\b|\biPhone\b|\biPad\b/.test(ua);
  const patterns: [ClientBrowser['family'], RegExp][] = [
    ['edge', /\bEdg(?:e|A|iOS)?\/(\d{1,4})/],
    ['firefox', /\b(?:Firefox|FxiOS)\/(\d{1,4})/],
    ['chrome', /\b(?:Chrome|CriOS)\/(\d{1,4})/],
    ['safari', /\bVersion\/(\d{1,4})[^ ]* (?:Mobile\/\S+ )?Safari\//],
  ];
  for (const [family, pattern] of patterns) {
    const match = pattern.exec(ua);
    if (match !== null) return { family, major: Number(match[1]), mobile };
  }
  return { family: 'other', major: null, mobile: false };
}
