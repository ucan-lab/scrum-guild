// Workers Builds のデプロイのコマンド（node scripts/deploy-production.ts）。手順は scripts/deploy.ts。
// セッションからは .claude/hooks/ のフックが止める。本番に触るのは Workers Builds だけ
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { migrationFiles } from './ci.ts';
import { deploy } from './deploy.ts';

// デプロイのコマンドは pnpm の外で動くので、node_modules/.bin が PATH に無い
const wranglerBin = path.join('node_modules', '.bin', 'wrangler');

const status = await deploy({
  commitSha: process.env.WORKERS_CI_COMMIT_SHA,
  wrangler: (args, { capture }) => {
    // 標準入力を閉じ、確認を待って止まらないようにする
    const result = spawnSync(wranglerBin, args, {
      stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
      encoding: 'utf8',
    });
    return {
      status: result.error ? 1 : (result.status ?? 1),
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  },
  hasMigrations: () => existsSync('migrations') && migrationFiles(readdirSync('migrations')).length > 0,
  fetchVersion: async (url, timeoutMs) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { version?: unknown };
    if (typeof body.version !== 'string') throw new Error('version がありません');
    return body.version;
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  log: (message) => console.log(message),
  error: (message) => console.error(message),
});
process.exit(status);
