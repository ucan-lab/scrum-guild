// Workers Builds のデプロイのコマンド（node scripts/deploy-production.ts）。手順は scripts/deploy.ts。
// 本番に触るのは Workers Builds だけ。セッションからは .claude/hooks/ のフックが止め、Workers Builds の外では deploy() も止まる
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isErrorBody } from '../src/shared/errors.ts';
import { migrationFiles } from './ci.ts';
import { deploy, versionFromHealth } from './deploy.ts';

// デプロイのコマンドは pnpm の外で動くので、node_modules/.bin が PATH に無い
const wranglerBin = path.join('node_modules', '.bin', 'wrangler');

// WORKERS_CI_COMMIT_SHA は、接続した直後の初回のビルド（手で動かしたビルド）でブランチ名の main だった。
// Workers Builds はコミットを checkout してからデプロイのコマンドを動かすので、作業ツリーの HEAD を版にする
function headCommit(): string | undefined {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`git rev-parse HEAD に失敗しました: ${result.error?.message ?? result.stderr.trim()}`);
    return undefined;
  }
  return result.stdout.trim() || undefined;
}

// import しても本番の入口が動かないよう、直に動かしたときだけ deploy() を呼ぶ（テストや別のスクリプトからの import を守る）。
// import.meta.main が無い Node（古い版）では、常に偽とみなすと何もしないまま成功に見えるので、理由を出して失敗させる
if (typeof import.meta.main !== 'boolean') {
  console.error(
    'import.meta.main が使えない Node です。import.meta.main が使える Node（.node-version の版）で動かしてください',
  );
  process.exit(1);
}

if (import.meta.main) {
  const inWorkersBuilds = process.env.WORKERS_CI === '1';
  const status = await deploy({
    inWorkersBuilds,
    // Workers Builds の外では、止まる理由を WORKERS_CI の1つにする
    commitSha: inWorkersBuilds ? headCommit() : undefined,
    wrangler: (args, { capture }) => {
      // 標準入力を閉じ、確認を待って止まらないようにする
      const result = spawnSync(wranglerBin, args, {
        stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
        encoding: 'utf8',
      });
      if (result.error) {
        // 出力を流す呼び出しでも、起動できなかった理由は残す
        console.error(`wrangler を起動できませんでした: ${result.error.message}`);
        return { status: 1, stdout: result.stdout ?? '', stderr: `${result.stderr ?? ''}\n${result.error.message}` };
      }
      return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
    hasMigrations: () => existsSync('migrations') && migrationFiles(readdirSync('migrations')).length > 0,
    fetchVersion: async (url, timeoutMs) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
      return versionFromHealth(res);
    },
    postStatus: async (url, init, timeoutMs) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: init.headers,
        body: init.body,
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
        // リダイレクトは辿らない。3xx は想定外の応答として、状態のまま返す
        redirect: 'manual',
      });
      // 本文は JSON のエラーの形のときだけ code を読む。読めなければ undefined
      const body: unknown = await res.json().catch(() => null);
      return { status: res.status, errorCode: isErrorBody(body) ? body.error.code : undefined };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (message) => console.log(message),
    error: (message) => console.error(message),
  });
  process.exit(status);
}
