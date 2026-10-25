// pnpm dev:open の引数の読み取りと、開く先の判定。通信とブラウザは scripts/dev-open.ts が受け持つ。
// 止める理由は例外でなく結果の reason で返す（scripts/ci.ts の ciOkVerdict と同じ形）
import { SEED_SESSIONS } from '../seed/sessions.ts';
import { resolvedReturnTo, safeReturnTo } from '../src/shared/return-to.ts';
import { sessionCookieName } from '../src/shared/session-cookie.ts';
import { devPorts, devPublicOrigin } from './dev-ports.ts';

export type SeedWho = keyof typeof SEED_SESSIONS;

export type DevOpenArgs = { preview: boolean; who: SeedWho; path: string };

export type DevOpenTarget = DevOpenArgs & {
  origin: string;
  url: string;
  cookieName: string;
  token: string;
};

type Failure = { ok: false; reason: string };

export const DEFAULT_WHO: SeedWho = 'admin';
export const DEFAULT_PATH = '/';

// seed のトークンを送ってよいのは、手元で動かしているサーバーだけ
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

function whoChoices(): string {
  return Object.entries(SEED_SESSIONS)
    .map(([key, session]) => `  ${key}: ${session.description}`)
    .join('\n');
}

function isSeedWho(value: string): value is SeedWho {
  return Object.hasOwn(SEED_SESSIONS, value);
}

// 位置でなく形で見分ける: `--preview` はフラグ、`/` で始まれば path、それ以外は who
export function parseDevOpenArgs(argv: readonly string[]): ({ ok: true } & DevOpenArgs) | Failure {
  let preview = false;
  let who: string | undefined;
  let path: string | undefined;
  for (const arg of argv) {
    if (arg === '--preview') {
      preview = true;
    } else if (arg.startsWith('--')) {
      return { ok: false, reason: `知らないフラグ ${arg} がある。使えるのは --preview だけ` };
    } else if (arg.startsWith('/')) {
      if (path !== undefined) return { ok: false, reason: `path が2つある（${path} と ${arg}）。1回に開くのは1つ` };
      path = arg;
    } else {
      if (who !== undefined) return { ok: false, reason: `who が2つある（${who} と ${arg}）。1回に開くのは1人` };
      who = arg;
    }
  }
  const resolvedWho = who ?? DEFAULT_WHO;
  if (!isSeedWho(resolvedWho)) {
    return {
      ok: false,
      reason: `知らない who: ${resolvedWho}。選べるのは次の4つ（開く path は / で始める。完全な URL は受け付けない）\n${whoChoices()}`,
    };
  }
  return { ok: true, preview, who: resolvedWho, path: path ?? DEFAULT_PATH };
}

// 開く先を決める。ここを通った結果だけが、Cookie を置いて通信してよい先になる
export function resolveDevOpenTarget(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): ({ ok: true } & DevOpenTarget) | Failure {
  const args = parseDevOpenArgs(argv);
  if (!args.ok) return args;
  const { preview, who, path } = args;

  // ログイン後の戻り先と同じ基準。`/` への直しはしない
  if (safeReturnTo(path) !== path) {
    return {
      ok: false,
      reason: `path ${path} は開けない。自分のサイトのパスだけを受け付ける（//host、バックスラッシュ、ドット区間、/api と /login で始まるパスは開けない）`,
    };
  }

  let origin: string;
  try {
    origin = devPublicOrigin(devPorts(env), preview);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  // 二重の守り: 解決した結果が path と変わらず、origin が手元のサーバーのときだけ進む
  const { protocol, hostname } = new URL(origin);
  if (protocol !== 'http:' || !LOCAL_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: `${origin} は手元のサーバーではないので、seed のトークンを送らない` };
  }
  if (resolvedReturnTo(path, origin) !== path) {
    return { ok: false, reason: `path ${path} は ${origin} の中で別のパスになるので開けない` };
  }

  return {
    ok: true,
    preview,
    who,
    path,
    origin,
    url: `${origin}${path}`,
    cookieName: sessionCookieName(origin),
    token: SEED_SESSIONS[who].token,
  };
}
