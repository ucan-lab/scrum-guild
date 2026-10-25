// pnpm install の prepare で、.githooks/ の git フックを使うよう設定する（docs/development.md の「`main` を守る仕組み」）。
// 相対のパスは、フックを動かす作業コピーの根から読まれるので、ワークツリーごとにそのブランチの .githooks/ が使われる。
// git の管理の外（tarball から展開した場所など）では何もしない。
import { spawnSync } from 'node:child_process';

const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
if (inside.error || inside.status !== 0) process.exit(0);

const result = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: ['ignore', 'ignore', 'inherit'] });
if (result.error || result.status !== 0) {
  console.error('git config core.hooksPath .githooks が失敗しました');
  process.exit(result.status ?? 1);
}
