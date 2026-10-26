// pnpm e2e のサーバーの決め方。e2e が、この実行で build したサーバーにだけ当たるようにする（#132）。
// 前の実行のサーバーが残っていると、Playwright は build し直さずにそれを使うか、build の間に答えたそれを使って先へ進む。
// そこで、手元ではこの実行だけの版で build し、e2e/global-setup.ts が /api/health の版と比べる
import { devPorts } from './dev-ports.ts';

type Env = Record<string, string | undefined>;

// 立てたままのサーバーを使い回すのは、手元で E2E_REUSE_SERVER=1 を付けたときだけ。CI では必ずこのコミットで build する
export function reuseExistingServer(env: Env): boolean {
  return !env.CI && env.E2E_REUSE_SERVER === '1';
}

// build と wrangler dev に渡す版。渡されていればそのまま使う（CI は PR の head の SHA）。
// 手元で渡されず、使い回さないときは、この実行だけの値にする。使い回すときは、版を渡さずに立てた preview と同じ dev
export function e2eServerVersion(env: Env, now: number): string {
  if (env.APP_VERSION) return env.APP_VERSION;
  return reuseExistingServer(env) ? 'dev' : `e2e-${now.toString(36)}`;
}

export function e2eHealthURL(env: Env): string {
  return `http://localhost:${devPorts(env).api}/api/health`;
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
