// pnpm install の prepare で、.githooks/ の git フックを使うよう設定する（docs/development.md の「`main` を守る仕組み」）。
// 相対のパスは、フックを動かす作業コピーの根から読まれるので、ワークツリーごとにそのブランチの .githooks/ が使われる。
// このリポジトリの根でないところ（git の管理外、別のリポジトリの中に展開した場所）では何もしない。
// 踏み線を張るだけの処理なので、失敗しても install（CI と Workers Builds のビルドを含む）は止めない。
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

const toplevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
});
if (toplevel.error || toplevel.status !== 0 || realpathSync(toplevel.stdout.trim()) !== realpathSync(process.cwd())) {
  process.exit(0);
}

const result = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: ['ignore', 'ignore', 'inherit'] });
if (result.error || result.status !== 0) {
  console.warn('git config core.hooksPath .githooks が失敗しました。main を守る git のフックは効いていません');
}
