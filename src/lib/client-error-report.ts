// 画面で捕まえていない例外と Promise の拒否を、POST /api/client-errors へ送る（Issue #376）。
// 送るのは、種類、名前、メッセージの先頭、場所（先頭の1か所。同じオリジンの /_app/ の下のパスと行・列だけ）、route.id、
// 画面の版だけ。スタックの残り、関数名、URL、Cookie は送らない。メッセージは画面が切って送り、サーバーが伏せる。
// 同じエラーはページを読み直すまで1回だけ、全体でも5件まで送る（数はメモリだけに持つ）。送る処理の失敗はやり直さず、
// 例外も外へ出さない（送る処理のエラーを、また送らないため）
import {
  CLIENT_ERROR_MAX_BODY_BYTES,
  CLIENT_ERROR_SENT_MESSAGE_LENGTH,
  type ClientErrorReport,
} from '../shared/client-error.ts';

const encoder = new TextEncoder();
const bodyBytes = (body: ClientErrorReport) => encoder.encode(JSON.stringify(body)).byteLength;

// 送る本文（JSON）がサーバーの上限（4KiB）に収まるよう、メッセージを切る。JSON は制御文字を \u0000 の6バイトに書くので、
// 1,000字に切っても上限を超えうる。超えた本文は 413 で断られ、どこにも残らないため。収まる最長の長さを二分探索で求める
function fitToBodyLimit(body: ClientErrorReport): ClientErrorReport {
  if (bodyBytes(body) <= CLIENT_ERROR_MAX_BODY_BYTES) return body;
  let low = 0;
  let high = body.message.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bodyBytes({ ...body, message: body.message.slice(0, middle) }) <= CLIENT_ERROR_MAX_BODY_BYTES) low = middle;
    else high = middle - 1;
  }
  return { ...body, message: body.message.slice(0, low) };
}

export type ClientErrorReporterOptions = {
  send: (report: ClientErrorReport) => void | Promise<void>;
  version: string;
  routeId: () => string | null;
  origin: string;
};

export type ClientErrorReporter = {
  onError(event: ErrorEvent): void;
  onRejection(event: PromiseRejectionEvent): void;
};

// ページを読み直すまでに送る数の上限
const MAX_REPORTS = 5;
// スキーマの name の上限（src/shared/client-error.ts）
const MAX_NAME_LENGTH = 200;

type ClientErrorLocation = NonNullable<ClientErrorReport['location']>;

// V8 の書き方（`    at 関数名 (URL:行:列)` か `    at URL:行:列`）
const V8_FRAME = /^\s*at (?:.*\()?(.+?):(\d+):(\d+)\)?$/;
// Firefox と Safari の書き方（`関数名@URL:行:列`）。Safari はモジュールの最上位と大域のコードを `module code@…`、
// `global code@…` と空白を含む名前で書くので、名前に空白を許す
const AT_SIGN_FRAME = /^[^@]*@(.+):(\d+):(\d+)$/;

export function createClientErrorReporter(options: ClientErrorReporterOptions): ClientErrorReporter {
  const sentKeys = new Set<string>();

  // 同じオリジンの /_app/ の下なら、オリジンとクエリを落としたパス。ほかは external
  function fileOf(url: string): string {
    try {
      const parsed = new URL(url, options.origin);
      return parsed.origin === options.origin && parsed.pathname.startsWith('/_app/') ? parsed.pathname : 'external';
    } catch {
      return 'external';
    }
  }

  function locationOf(url: string, line: number, column: number): ClientErrorLocation | null {
    if (url === '') return null;
    return { file: fileOf(url), line: Math.max(0, Math.trunc(line)), column: Math.max(0, Math.trunc(column)) };
  }

  // stack の先頭のフレームだけから場所を取る。関数名と引数は取らない
  function locationOfStack(stack: string | undefined): ClientErrorLocation | null {
    for (const line of (stack ?? '').split('\n')) {
      const match = V8_FRAME.exec(line) ?? AT_SIGN_FRAME.exec(line);
      if (match !== null) return locationOf(match[1]!, Number(match[2]), Number(match[3]));
    }
    return null;
  }

  function nameOf(error: Error): string {
    return error.name === '' ? 'Error' : error.name.slice(0, MAX_NAME_LENGTH);
  }

  function report(
    kind: ClientErrorReport['kind'],
    name: string,
    message: string,
    location: ClientErrorLocation | null,
  ): void {
    const body = fitToBodyLimit({
      kind,
      name,
      message: message.slice(0, CLIENT_ERROR_SENT_MESSAGE_LENGTH),
      location,
      route: options.routeId(),
      clientVersion: options.version,
    });
    const key = JSON.stringify([body.kind, body.name, body.message, body.location]);
    if (sentKeys.has(key) || sentKeys.size >= MAX_REPORTS) return;
    sentKeys.add(key);
    const sending = options.send(body);
    // 送る処理の拒否を、捕まえていない拒否にしない
    if (sending instanceof Promise) sending.catch(() => {});
  }

  return {
    onError(event) {
      try {
        const error: unknown = event.error;
        const location = locationOf(event.filename ?? '', event.lineno ?? 0, event.colno ?? 0);
        if (error instanceof Error) report('error', nameOf(error), error.message, location);
        else report('error', 'Error', String(event.message ?? ''), location);
      } catch {
        // 送る処理の例外は握りつぶす
      }
    },
    onRejection(event) {
      try {
        const reason: unknown = event.reason;
        if (reason instanceof Error) {
          report('unhandledrejection', nameOf(reason), reason.message, locationOfStack(reason.stack));
        } else {
          // Error でない拒否は、文字列ならそのまま、ほかは型の名前だけ（オブジェクトの中身を送らない）
          const message =
            typeof reason === 'string' ? reason : `Non-Error rejection (${reason === null ? 'null' : typeof reason})`;
          report('unhandledrejection', 'Error', message, null);
        }
      } catch {
        // 送る処理の例外は握りつぶす
      }
    },
  };
}

// window に付け、外す関数を返す。src/routes/+layout.svelte が page.route.id と、$app/env の version
// （vite.config.ts の kit.version.name）を渡して呼ぶ。$app は SvelteKit の外（vitest）で解決できないので、ここでは import しない
export function installClientErrorReporter(routeId: () => string | null, version: string): () => void {
  const reporter = createClientErrorReporter({
    send: async (report) => {
      await fetch('/api/client-errors', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      });
    },
    version,
    routeId,
    origin: location.origin,
  });
  const onError = (event: ErrorEvent) => reporter.onError(event);
  const onRejection = (event: PromiseRejectionEvent) => reporter.onRejection(event);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
