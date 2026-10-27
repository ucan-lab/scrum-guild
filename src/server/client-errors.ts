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
        clientVersion: report.clientVersion,
        version: c.env.APP_VERSION || 'dev',
        browser: browserOf(c.req.header('User-Agent')),
      }),
    );
    return c.body(null, 204);
  });

  return app;
}

// 引用符（'…'、"…"、`…`）の中身。閉じていない引用符はそのまま残す
const QUOTED = /'[^']*'|"[^"]*"|`[^`]*`/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// 引用符の中身と UUID らしい値を … に置き換えてから、先頭 200 字にする。切ってから伏せると、200字をまたぐ引用符の中身が漏れる
export function maskClientErrorMessage(text: string): string {
  const masked = text.replace(QUOTED, (quoted) => `${quoted[0]}…${quoted[0]}`).replace(UUID, '…');
  if (masked.length <= CLIENT_ERROR_LOGGED_MESSAGE_LENGTH) return masked;
  // サロゲートペアの片方だけを残さない
  const end = CLIENT_ERROR_LOGGED_MESSAGE_LENGTH;
  const code = masked.charCodeAt(end - 1);
  return masked.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end);
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
