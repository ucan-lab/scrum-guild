import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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

  test('main への push を止め、作業ブランチへの push は通す', () => {
    const work = setUp('push');
    git(work, 'checkout', '-b', '1-x');
    git(work, 'commit', '--allow-empty', '-m', 'x');
    const toMain = git(work, 'push', 'origin', 'HEAD:main');
    assert.notEqual(toMain.status, 0);
    assert.match(toMain.stderr, /main へは push しない/);
    assert.notEqual(git(work, 'push', 'origin', '--delete', 'main').status, 0);
    assert.equal(git(work, 'push', 'origin', '1-x').status, 0);
  });
});
