// pnpm install の prepare で、.githooks/ の git フックを使うよう設定する（docs/development.md の「`main` を守る仕組み」）。
// 相対のパスは、フックを動かす作業コピーの根から読まれるので、ワークツリーごとにそのブランチの .githooks/ が使われる。
// このリポジトリの根でないところ（git の管理外、別のリポジトリの中に展開した場所）では何もしない。
// 人が別の core.hooksPath（husky やシークレットの検査）を設定していれば、上書きせずに知らせる。
// 踏み線を張るだけの処理なので、失敗しても install（CI と Workers Builds のビルドを含む）は止めない。
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

const HOOKS_PATH = '.githooks';

function isRepositoryRoot(): boolean {
  const toplevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (toplevel.error || toplevel.status !== 0) return false;
  try {
    return realpathSync(toplevel.stdout.trim()) === realpathSync(process.cwd());
  } catch {
    return false;
  }
}

if (!isRepositoryRoot()) process.exit(0);

const current = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
});
const existing = current.status === 0 ? current.stdout.trim() : '';
if (existing !== '' && existing !== HOOKS_PATH) {
  console.warn(
    `core.hooksPath が ${existing} なので上書きしません。main を守る git のフック（${HOOKS_PATH}/）は効いていません`,
  );
  process.exit(0);
}

const result = spawnSync('git', ['config', 'core.hooksPath', HOOKS_PATH], { stdio: ['ignore', 'ignore', 'inherit'] });
if (result.error || result.status !== 0) {
  console.warn(`git config core.hooksPath ${HOOKS_PATH} が失敗しました。main を守る git のフックは効いていません`);
}
