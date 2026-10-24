// 本番へのデプロイの手順（docs/development.md の「CD」）。Workers Builds のデプロイのコマンドが
// scripts/deploy-production.ts から呼ぶ。wrangler と HTTP を差し替えて node --test にかけられるよう、外への作用は deps で受け取る。

// 煙のテストが叩く本番の URL。ドメインへ移すときはここを直す（docs/operations.md の「ドメインへ移す」）
export const PRODUCTION_URL = 'https://scrum-guild.ucan-lab.workers.dev';

export const SMOKE_INTERVAL_MS = 5_000;
export const SMOKE_TIMEOUT_MS = 120_000;
export const SMOKE_REQUEST_TIMEOUT_MS = 10_000;

export type WranglerResult = { status: number; stdout: string; stderr: string };

export type DeployDeps = {
  commitSha: string | undefined;
  // capture が真なら出力を受け取り、偽ならそのままログに流す
  wrangler: (args: string[], options: { capture: boolean }) => WranglerResult;
  hasMigrations: () => boolean;
  // /api/health の version を返す。取れなければ投げる
  fetchVersion: (url: string, timeoutMs: number) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
  error: (message: string) => void;
};

// Worker が無い（API の 10007）か、Worker はあってもデプロイが1つも無い。どちらも戻し先が無い
const NO_DEPLOYMENT = [/\[code: 10007\]/, /has no deployments/];

type RollbackTarget = { ok: true; versionId: string | null } | { ok: false; reason: string };

// wrangler deployments status --json の結果から、今 100% で動いている版を取る
export function rollbackTarget(result: WranglerResult): RollbackTarget {
  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (NO_DEPLOYMENT.some((pattern) => pattern.test(output))) return { ok: true, versionId: null };
    return { ok: false, reason: `今の版を取れませんでした（終了コード ${result.status}）` };
  }
  let deployment: unknown;
  try {
    deployment = JSON.parse(result.stdout);
  } catch {
    return { ok: false, reason: '今の版の JSON を読めませんでした' };
  }
  const versions = (deployment as { versions?: unknown }).versions;
  if (!Array.isArray(versions)) return { ok: false, reason: '今の版の JSON に versions がありません' };
  // 自分たちは版を分けて流さないので、分かれていたら人が触った異常として止める
  if (versions.length !== 1 || versions[0]?.percentage !== 100 || typeof versions[0]?.version_id !== 'string') {
    return { ok: false, reason: `今の版が 100% で動いていません: ${JSON.stringify(versions)}` };
  }
  return { ok: true, versionId: versions[0].version_id };
}

async function waitForVersion(deps: DeployDeps, expected: string): Promise<boolean> {
  const url = `${PRODUCTION_URL}/api/health`;
  const started = deps.now();
  for (let attempt = 1; ; attempt++) {
    try {
      const version = await deps.fetchVersion(url, SMOKE_REQUEST_TIMEOUT_MS);
      if (version === expected) {
        deps.log(`煙のテスト: ${attempt}回目で版が一致しました（${Math.round((deps.now() - started) / 1000)}秒）`);
        return true;
      }
      deps.log(`煙のテスト: ${attempt}回目は版が ${version} でした`);
    } catch (err) {
      deps.log(`煙のテスト: ${attempt}回目は取得に失敗しました（${err instanceof Error ? err.message : String(err)}）`);
    }
    if (deps.now() - started + SMOKE_INTERVAL_MS > SMOKE_TIMEOUT_MS) return false;
    await deps.sleep(SMOKE_INTERVAL_MS);
  }
}

// 成功なら 0、失敗なら 1 を返す
export async function deploy(deps: DeployDeps): Promise<number> {
  const sha = deps.commitSha;
  // 版の無いまま出すと、本番の版が dev になり煙のテストで見分けられない
  if (!sha) {
    deps.error('WORKERS_CI_COMMIT_SHA がありません。本番に触らずに終えます');
    return 1;
  }

  const target = rollbackTarget(deps.wrangler(['deployments', 'status', '--json'], { capture: true }));
  if (!target.ok) {
    deps.error(`${target.reason}。本番に触らずに終えます`);
    return 1;
  }
  deps.log(target.versionId ? `戻し先の版: ${target.versionId}` : '戻し先の版はありません（初回）');

  // migrations/ が無いと apply が失敗するので、ファイルが無ければ飛ばす。未適用の有無は判定せず、
  // 当てる前のブックマークを毎回残す（未適用が無ければ apply は何もしない）
  if (deps.hasMigrations()) {
    const bookmark = deps.wrangler(['d1', 'time-travel', 'info', 'DB', '--json'], { capture: true });
    if (bookmark.status !== 0) {
      deps.error(`${bookmark.stderr}\nTime Travel のブックマークを取れませんでした。本番に触らずに終えます`);
      return 1;
    }
    deps.log(`マイグレーションを当てる前の Time Travel のブックマーク: ${bookmark.stdout.trim()}`);
    if (deps.wrangler(['d1', 'migrations', 'apply', 'DB', '--remote'], { capture: false }).status !== 0) {
      deps.error('マイグレーションを当てられませんでした。版は切り替えていません');
      return 1;
    }
  }

  if (deps.wrangler(['deploy', '--var', `APP_VERSION:${sha}`, '--message', sha], { capture: false }).status !== 0) {
    deps.error('版を上げられませんでした');
    return 1;
  }

  if (await waitForVersion(deps, sha)) return 0;

  deps.error(`煙のテスト: ${SMOKE_TIMEOUT_MS / 1000}秒待っても版が ${sha} になりませんでした`);
  if (!target.versionId) {
    deps.error('戻し先が無く、壊れた版が残っています。docs/operations.md の「戻し方」を見てください');
    return 1;
  }
  const rollback = deps.wrangler(['rollback', target.versionId, '--message', `煙のテストの失敗で ${sha} から戻す`], {
    capture: false,
  });
  if (rollback.status !== 0) {
    deps.error(`${target.versionId} へ戻せませんでした。壊れた版が残っています`);
    return 1;
  }
  deps.error(`${target.versionId} へ戻しました`);
  return 1;
}
