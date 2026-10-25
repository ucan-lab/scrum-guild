// Workers Builds のデプロイのコマンド（node scripts/deploy-production.ts）。手順は scripts/deploy.ts。
// 本番に触るのは Workers Builds だけ。セッションからは .claude/hooks/ のフックが止め、Workers Builds の外では deploy() も止まる
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isHealth } from '../src/shared/health.ts';
import { migrationFiles } from './ci.ts';
import { deploy } from './deploy.ts';

// デプロイのコマンドは pnpm の外で動くので、node_modules/.bin が PATH に無い
const wranglerBin = path.join('node_modules', '.bin', 'wrangler');

// WORKERS_CI_COMMIT_SHA は、手で動かしたビルド（接続した直後の初回、Retry build）ではブランチ名の main になる。
// Workers Builds はコミットを checkout してからデプロイのコマンドを動かすので、作業ツリーの HEAD を版にする
function headCommit(): string | undefined {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (result.status !== 0) {
    console.error(`git rev-parse HEAD に失敗しました: ${result.error?.message ?? result.stderr.trim()}`);
    return undefined;
  }
  return result.stdout.trim();
}

const status = await deploy({
  inWorkersBuilds: process.env.WORKERS_CI === '1',
  commitSha: headCommit(),
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!isHealth(body)) throw new Error('health の形ではありません');
    return body.version;
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  log: (message) => console.log(message),
  error: (message) => console.error(message),
});
process.exit(status);
