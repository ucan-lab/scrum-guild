import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const hooksDir = fileURLToPath(new URL('../.githooks', import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), 'git-hooks-'));
after(() => rmSync(root, { recursive: true, force: true }));

// 呼び出し元の git の設定（署名、グローバルのフック）に左右されないよう、設定を空にして動かす
function git(cwd: string, ...args: string[]) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
}

function setUp(name: string) {
  const remote = path.join(root, `${name}.git`);
  const work = path.join(root, name);
  git(root, 'init', '--bare', '-b', 'main', remote);
  git(root, 'clone', remote, work);
  for (const [key, value] of [
    ['user.name', 'Test'],
    ['user.email', 'test@example.com'],
    ['commit.gpgsign', 'false'],
  ]) {
    git(work, 'config', key, value);
  }
  git(work, 'checkout', '-b', 'main');
  git(work, 'commit', '--allow-empty', '-m', 'init');
  git(work, 'push', 'origin', 'main');
  git(work, 'config', 'core.hooksPath', hooksDir);
  return work;
}

describe('.githooks', () => {
  test('main の上のコミットを止め、作業ブランチでは通す', () => {
    const work = setUp('commit');
    const onMain = git(work, 'commit', '--allow-empty', '-m', 'x');
    assert.notEqual(onMain.status, 0);
    assert.match(onMain.stderr, /main の上ではコミットしない/);
    // prepare-commit-msg は --no-verify でも動く
    assert.notEqual(git(work, 'commit', '--no-verify', '--allow-empty', '-m', 'x').status, 0);
    // 同名のタグがあっても main とみなす
    git(work, 'tag', 'main');
    assert.notEqual(git(work, 'commit', '--allow-empty', '-m', 'x').status, 0);
    git(work, 'tag', '-d', 'main');
    git(work, 'checkout', '-b', '1-x');
    assert.equal(git(work, 'commit', '--allow-empty', '-m', 'x').status, 0);
  });

  test('main の上のマージのコミットを止め、fast-forward は通す', () => {
    const work = setUp('merge');
    git(work, 'checkout', '-b', '1-x');
    git(work, 'commit', '--allow-empty', '-m', 'x');
    git(work, 'checkout', 'main');
    assert.notEqual(git(work, 'merge', '--no-ff', '-m', 'm', '1-x').status, 0);
    // フックに止められたマージは途中の状態で残る
    git(work, 'merge', '--abort');
    assert.equal(git(work, 'merge', '--ff-only', '1-x').status, 0);
  });

  test('main の上の cherry-pick、revert、am を止める', () => {
    const work = setUp('pick');
    // 戻す対象のコミットを main に作る。空のコミットは revert が別の理由で失敗するので、中身を持たせる
    writeFileSync(path.join(work, 'a.txt'), 'a\n');
    git(work, 'add', 'a.txt');
    git(work, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'a');
    const head = git(work, 'rev-parse', 'HEAD').stdout.trim();
    git(work, 'checkout', '-b', '1-x');
    writeFileSync(path.join(work, 'b.txt'), 'b\n');
    git(work, 'add', 'b.txt');
    git(work, 'commit', '-m', 'b');
    const sha = git(work, 'rev-parse', 'HEAD').stdout.trim();
    const patch = path.join(root, 'pick.patch');
    git(work, 'format-patch', '-1', 'HEAD', '--output', patch);
    git(work, 'checkout', 'main');
    for (const [sub, ...args] of [
      ['cherry-pick', sha],
      ['revert', '--no-edit', head],
      ['am', patch],
    ]) {
      const result = git(work, sub, ...args);
      assert.notEqual(result.status, 0, sub);
      assert.match(result.stderr, /main の上ではコミットしない/, sub);
      // 止められた後は、--abort しても index に変更が残ることがある
      git(work, sub, '--abort');
      git(work, 'reset', '--hard', head);
    }
    assert.equal(git(work, 'rev-parse', 'HEAD').stdout.trim(), head);
  });

  test('main への push を止め、作業ブランチへの push は通す', () => {
    const work = setUp('push');
    git(work, 'checkout', '-b', '1-x');
    git(work, 'commit', '--allow-empty', '-m', 'x');
    const toMain = git(work, 'push', 'origin', 'HEAD:main');
    assert.notEqual(toMain.status, 0);
    assert.match(toMain.stderr, /main へは push しない/);
    // bare のリモートはフックが無くても今の HEAD の削除を拒むので、拒んだのがフックかを文言で見る
    assert.match(git(work, 'push', 'origin', '--delete', 'main').stderr, /main へは push しない/);
    assert.equal(git(work, 'push', 'origin', '1-x').status, 0);
  });
});
