// pnpm e2e のサーバーの決め方。e2e が、この実行で build したサーバーにだけ当たるようにする（#132）。
// 前の実行のサーバーが残っていると、Playwright は build し直さずにそれを使うか、build の間に答えたそれを使って先へ進む。
// そこで、手元ではこの実行だけの版で build し、e2e/global-setup.ts が /api/health の版と比べる
import { devPorts } from './dev-ports.ts';

type Env = Record<string, string | undefined>;

// 立てたままのサーバーを使い回すのは、手元で E2E_REUSE_SERVER=1 を付けたときだけ。CI では必ずこのコミットで build する
export function reuseExistingServer(env: Env): boolean {
  return !env.CI && env.E2E_REUSE_SERVER === '1';
}

// build と wrangler dev に渡す版。CI は渡された PR の head の SHA をそのまま使う。
// 手元で使い回さないときは、この実行だけの値にする。渡された版があれば、その後ろに足す（同じ版で立てた前のサーバーを見分けるため）。
// 使い回すときは、渡された版か、版を渡さずに立てた preview と同じ dev
export function e2eServerVersion(env: Env, now: number): string {
  if (env.CI || reuseExistingServer(env)) return env.APP_VERSION || 'dev';
  const run = `e2e-${now.toString(36)}`;
  return env.APP_VERSION ? `${env.APP_VERSION}-${run}` : run;
}

// 版を決めて env に置く。playwright.config.ts はワーカーでも読み直されるので、決めた版を E2E_SERVER_VERSION に残し、
// 読み直しでは足し直さない。ワーカーは起動した側の env を受け継ぐので、同じ実行の中では1つの値になる
export function applyE2eServerVersion(env: Env, now: number): string {
  env.E2E_SERVER_VERSION ||= e2eServerVersion(env, now);
  env.APP_VERSION = env.E2E_SERVER_VERSION;
  return env.APP_VERSION;
}

export function e2eHealthURL(env: Env): string {
  return `http://localhost:${devPorts(env).api}/api/health`;
}

// 前のサーバーが答えないまま接続だけ受けると、globalSetup はいつまでも待つので上限を置く
export const HEALTH_TIMEOUT_MS = 10_000;

export function healthUnreachable(env: Env, cause: unknown): string {
  const port = devPorts(env).api;
  const reason = cause instanceof Error ? cause.message : String(cause);
  return `/api/health に問い合わせられない（${reason}）。ポート ${port} で前のサーバーが固まっていないかを確かめ、止めてからやり直す（lsof -i :${port} で探す）`;
}

// /api/health の版が期待と違えば、止める理由を返す
export function serverVersionMismatch(expected: string, actual: unknown, env: Env): string | undefined {
  if (actual === expected) return undefined;
  const port = devPorts(env).api;
  const hint = reuseExistingServer(env)
    ? `E2E_REUSE_SERVER=1 で使い回したサーバーが、APP_VERSION（${expected}）と違う版で立っている。版をそろえて立て直すか、E2E_REUSE_SERVER を外す`
    : `この実行で build したサーバーでなく、前の e2e か pnpm preview のサーバーがポート ${port} で答えている。そのプロセスを止めてからやり直す（lsof -i :${port} で探す）`;
  return `/api/health の版が ${JSON.stringify(actual)} で、期待した ${expected} と違う。${hint}`;
}
