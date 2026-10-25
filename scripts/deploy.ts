// 本番へのデプロイの手順（docs/development.md の「CD」）。Workers Builds のデプロイのコマンドが
// scripts/deploy-production.ts から呼ぶ。wrangler と HTTP を差し替えて node --test にかけられるよう、外への作用は deps で受け取る。

import { isErrorBody } from '../src/shared/errors.ts';
import { isHealth } from '../src/shared/health.ts';

// 煙のテストが叩く本番の URL。ドメインへ移すときはここを直す（docs/operations.md の「ドメインへ移す」）
export const PRODUCTION_URL = 'https://scrum-guild.ucan-lab.workers.dev';

export const SMOKE_INTERVAL_MS = 5_000;
export const SMOKE_TIMEOUT_MS = 120_000;
export const SMOKE_REQUEST_TIMEOUT_MS = 10_000;

export type WranglerResult = { status: number; stdout: string; stderr: string };

export type DeployDeps = {
  // Workers Builds の中か（WORKERS_CI）
  inWorkersBuilds: boolean;
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

// コミットの SHA の形（git rev-parse HEAD の出力）。dev やブランチ名を版として出さない
const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

type RollbackTarget = { ok: true; versionId: string | null } | { ok: false; reason: string };

// 取り込んだ wrangler の出力を、失敗の理由としてログに添える。長い出力は末尾だけにする
function outputOf(result: WranglerResult): string {
  return `${result.stdout}\n${result.stderr}`.trim().slice(-2_000);
}

// wrangler deployments status --json の結果から、今 100% で動いている版を取る
export function rollbackTarget(result: WranglerResult): RollbackTarget {
  if (result.status !== 0) {
    if (NO_DEPLOYMENT.some((pattern) => pattern.test(outputOf(result)))) return { ok: true, versionId: null };
    return { ok: false, reason: `今の版を取れませんでした（終了コード ${result.status}）\n${outputOf(result)}` };
  }
  let deployment: unknown;
  try {
    deployment = JSON.parse(result.stdout);
  } catch {
    return { ok: false, reason: `今の版の JSON を読めませんでした\n${outputOf(result)}` };
  }
  const versions =
    typeof deployment === 'object' && deployment !== null && 'versions' in deployment ? deployment.versions : undefined;
  if (!Array.isArray(versions))
    return { ok: false, reason: `今の版の JSON に versions がありません\n${outputOf(result)}` };
  // 自分たちは版を分けて流さないので、分かれていたら人が触った異常として止める
  if (versions.length !== 1 || versions[0]?.percentage !== 100 || typeof versions[0]?.version_id !== 'string') {
    return { ok: false, reason: `今の版が 100% で動いていません: ${JSON.stringify(versions)}` };
  }
  return { ok: true, versionId: versions[0].version_id };
}

// /api/health の応答から version を取る。D1 に届かない版は 503 を返すので、200 以外は失敗として投げ、煙のテストの失敗にする
export async function versionFromHealth(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new Error(isErrorBody(body) ? `HTTP ${res.status}（${body.error.code}）` : `HTTP ${res.status}`);
  if (!isHealth(body)) throw new Error('health の形ではありません');
  return body.version;
}

async function waitForVersion(deps: DeployDeps, expected: string): Promise<boolean> {
  const url = `${PRODUCTION_URL}/api/health`;
  const started = deps.now();
  const deadline = started + SMOKE_TIMEOUT_MS;
  // 問い合わせの開始を5秒おきに置き、遅い応答の後に5秒を足さない。1回の打ち切りも期限で縮め、2分を超えない
  for (let attempt = 1, attemptStart = started; attemptStart < deadline; attempt++) {
    try {
      const version = await deps.fetchVersion(url, Math.min(SMOKE_REQUEST_TIMEOUT_MS, deadline - attemptStart));
      if (version === expected) {
        deps.log(`煙のテスト: ${attempt}回目で版が一致しました（${Math.round((deps.now() - started) / 1000)}秒）`);
        return true;
      }
      deps.log(`煙のテスト: ${attempt}回目は版が ${version} でした`);
    } catch (err) {
      deps.log(`煙のテスト: ${attempt}回目は取得に失敗しました（${err instanceof Error ? err.message : String(err)}）`);
    }
    const next = attemptStart + SMOKE_INTERVAL_MS;
    if (next >= deadline) break;
    await deps.sleep(Math.max(0, next - deps.now()));
    attemptStart = deps.now();
  }
  return false;
}

// 成功なら 0、失敗なら 1 を返す
export async function deploy(deps: DeployDeps): Promise<number> {
  // 手元に wrangler のログインが残っていると、作業ツリーがそのまま本番に出る。フックだけに頼らず、ここでも止める
  if (!deps.inWorkersBuilds) {
    deps.error('Workers Builds の外では動かしません（WORKERS_CI が 1 でない）。本番に触らずに終えます');
    return 1;
  }
  const sha = deps.commitSha;
  // 版の無いまま出すと、本番の版が dev になり煙のテストで見分けられない
  if (!sha || !COMMIT_SHA.test(sha)) {
    deps.error(`版がコミットの SHA ではありません（${sha ?? '無し'}）。本番に触らずに終えます`);
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
      deps.error(`${outputOf(bookmark)}\nTime Travel のブックマークを取れませんでした。本番に触らずに終えます`);
      return 1;
    }
    deps.log(`マイグレーションを当てる前の Time Travel のブックマーク: ${bookmark.stdout.trim()}`);
    if (deps.wrangler(['d1', 'migrations', 'apply', 'DB', '--remote'], { capture: false }).status !== 0) {
      deps.error('マイグレーションを当てられませんでした。版は切り替えていません');
      return 1;
    }
  }

  // Workers Builds が並んで走ると、控えた後に別のビルドが版を上げていることがある。その上に出すと戻し先を誤るので止める
  const beforeDeploy = rollbackTarget(deps.wrangler(['deployments', 'status', '--json'], { capture: true }));
  if (!beforeDeploy.ok || beforeDeploy.versionId !== target.versionId) {
    deps.error(
      '控えた後に本番の版が変わりました。別のデプロイが走っていないか確かめてください。版は切り替えていません',
    );
    return 1;
  }

  if (deps.wrangler(['deploy', '--var', `APP_VERSION:${sha}`, '--message', sha], { capture: false }).status !== 0) {
    // wrangler deploy は版を 100% に切り替えた後の triggers の反映でも落ちるので、切り替わったかを見直す
    const after = rollbackTarget(deps.wrangler(['deployments', 'status', '--json'], { capture: true }));
    if (after.ok && after.versionId === target.versionId) {
      deps.error('版を上げられませんでした。版は切り替わっていません');
      return 1;
    }
    deps.error('版を上げる途中で失敗しました。版が切り替わったか確かめられないか、切り替わっています');
    return failAfterSwitch(deps, target.versionId, `デプロイの失敗で ${sha} から戻す`);
  }

  // 煙のテストの間に別のビルドが版を上げると、戻すとその版を潰す。戻す前に比べられるよう、上げた直後の版を控える
  const deployed = rollbackTarget(deps.wrangler(['deployments', 'status', '--json'], { capture: true }));
  const ownVersionId = deployed.ok ? deployed.versionId : null;

  if (await waitForVersion(deps, sha)) return 0;

  deps.error(`煙のテスト: ${SMOKE_TIMEOUT_MS / 1000}秒待っても版が ${sha} になりませんでした`);
  if (ownVersionId) {
    const current = rollbackTarget(deps.wrangler(['deployments', 'status', '--json'], { capture: true }));
    if (current.ok && current.versionId !== ownVersionId) {
      deps.error(
        `本番の版が、上げた版（${ownVersionId}）から ${current.versionId ?? '無し'} に変わっています。別のデプロイを潰さないよう戻しません`,
      );
      return 1;
    }
  }
  return failAfterSwitch(deps, target.versionId, `煙のテストの失敗で ${sha} から戻す`);
}

// 本番が切り替わった後の失敗。戻し先があれば戻し、どちらでも失敗で終える
function failAfterSwitch(deps: DeployDeps, versionId: string | null, reason: string): number {
  if (!versionId) {
    deps.error('戻し先が無く、壊れた版が残っています。docs/operations.md の「戻し方」を見てください');
    return 1;
  }
  if (deps.wrangler(['rollback', versionId, '--message', reason], { capture: false }).status !== 0) {
    deps.error(
      `${versionId} へ戻せませんでした。壊れた版が残っています。docs/operations.md の「戻し方」を見てください`,
    );
    return 1;
  }
  deps.error(
    `${versionId} へ戻しました。cron やルート（triggers）の変更とマイグレーションは戻していません。docs/operations.md の「戻し方」を見てください`,
  );
  return 1;
}
