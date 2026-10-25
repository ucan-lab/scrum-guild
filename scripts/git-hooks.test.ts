import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const hooksDir = fileURLToPath(new URL('../.githooks', import.meta.url));
const root = mkdtempSync(path.join(os.tmpdir(), 'git-hooks-'));
after(() => rmSync(root, { recursive: true, force: true }));

// 呼び出し元の git の設定（署名、グローバルのフック）に左右されないよう、設定を空にして動かす
function gitWith(env: NodeJS.ProcessEnv, cwd: string, ...args: string[]) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env },
  });
}

function git(cwd: string, ...args: string[]) {
  return gitWith({}, cwd, ...args);
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

describe('scripts/git-hooks.ts', () => {
  const script = fileURLToPath(new URL('./git-hooks.ts', import.meta.url));
  const run = (cwd: string) =>
    spawnSync(process.execPath, [script], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
  const hooksPath = (cwd: string) => git(cwd, 'config', '--get', 'core.hooksPath').stdout.trim();

  test('リポジトリの根で .githooks を設定し、別の値は上書きしない', () => {
    const repo = path.join(root, 'setup');
    git(root, 'init', '-q', '-b', 'main', repo);
    assert.equal(run(repo).status, 0);
    assert.equal(hooksPath(repo), '.githooks');
    git(repo, 'config', 'core.hooksPath', '.husky');
    const kept = run(repo);
    assert.equal(kept.status, 0);
    assert.match(kept.stderr, /上書きしません/);
    assert.equal(hooksPath(repo), '.husky');
  });

  test('リポジトリの根でなければ何もしない', () => {
    const repo = path.join(root, 'nested');
    git(root, 'init', '-q', '-b', 'main', repo);
    const sub = path.join(repo, 'sub');
    mkdirSync(sub);
    assert.equal(run(sub).status, 0);
    assert.equal(hooksPath(repo), '');
  });
});

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

  describe('post-checkout', () => {
    // 本物の gh の代わりに、受けた引数を記録するか失敗するだけの gh を PATH の先頭に置く
    function fakeGh(name: string, body: string) {
      const bin = path.join(root, `${name}-bin`);
      mkdirSync(bin);
      writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return { PATH: `${bin}:${process.env.PATH}` };
    }

    test('番号付きのブランチのワークツリーを切ると、開いた Issue を作業中にする', () => {
      const work = setUp('worktree');
      const log = path.join(root, 'worktree-gh.log');
      // 12 は開いた Issue、20 は閉じた Issue、21 は PR。ほかの番号は無い
      const env = fakeGh(
        'worktree',
        [
          `echo "$*" >> '${log}'`,
          'case "$*" in',
          `  *"issues/12 --jq"*) echo 'open false' ;;`,
          `  *"issues/20 --jq"*) echo 'closed false' ;;`,
          `  *"issues/21 --jq"*) echo 'open true' ;;`,
          `  *--jq*) echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;`,
          'esac',
        ].join('\n'),
      );
      const add = (name: string, ...args: string[]) =>
        gitWith(env, work, 'worktree', 'add', path.join(root, `wt-${name}`), ...args);
      const added = add('12', '-b', '12-x');
      assert.equal(added.status, 0);
      assert.match(added.stderr, /#12 を作業中/);
      // 閉じた Issue、PR、無い番号（日付で始まるブランチ）には付けない
      assert.equal(add('20', '-b', '20-x').status, 0);
      assert.equal(add('21', '-b', '21-x').status, 0);
      const dated = add('dated', '-b', '2026-10-25-x');
      assert.equal(dated.status, 0);
      assert.match(dated.stderr, /#2026 を引けなかった.*HTTP 404/);
      // 番号の無いブランチ、0 で始まる番号、detached、既にある作業コピーでのブランチの作成では、Issue を引きもしない
      assert.equal(add('x', '-b', 'feature-x').status, 0);
      assert.equal(add('0', '-b', '012-x').status, 0);
      assert.equal(add('detached', '--detach').status, 0);
      assert.equal(gitWith(env, work, 'checkout', '-b', '13-y').status, 0);
      // clone と、コミットの無い作業コピーでの最初の checkout も、前の HEAD が null の SHA になるが、追加のワークツリーではないので動かない
      git(work, 'push', 'origin', '13-y:16-x');
      const remote = path.join(root, 'worktree.git');
      assert.equal(
        gitWith(env, root, '-c', `core.hooksPath=${hooksDir}`, 'clone', '-b', '16-x', remote, 'worktree-clone').status,
        0,
      );
      const fresh = path.join(root, 'worktree-fresh');
      git(root, 'init', '-q', '-b', 'main', fresh);
      git(fresh, 'config', 'core.hooksPath', hooksDir);
      git(fresh, 'fetch', '-q', remote, '16-x');
      assert.equal(gitWith(env, fresh, 'checkout', '-b', '17-x', 'FETCH_HEAD').status, 0);
      const calls = readFileSync(log, 'utf8').trimEnd().split('\n');
      assert.deepEqual(
        calls.filter((c) => c.includes('--jq')).map((c) => c.match(/issues\/(\d+) /)?.[1]),
        ['12', '20', '21', '2026'],
      );
      assert.deepEqual(
        calls.filter((c) => !c.includes('--jq')),
        [
          'api -X POST repos/ucan-lab/scrum-guild/issues/12/labels -f labels[]=status:in-progress',
          'api -X DELETE repos/ucan-lab/scrum-guild/issues/12/labels/status:refining',
        ],
      );
    });

    test('gh が失敗しても、無くても、ワークツリーの作成は止めない', () => {
      const work = setUp('worktree-fail');
      // Issue を引くのは 14 で失敗し、ほかは引けるがラベルの書き込みで失敗する
      const env = fakeGh(
        'worktree-fail',
        [
          'case "$*" in',
          `  *"issues/14 --jq"*) echo 'HTTP 401: Bad credentials' >&2; exit 1 ;;`,
          `  *--jq*) echo 'open false' ;;`,
          `  *) echo 'HTTP 422: Validation Failed' >&2; exit 1 ;;`,
          'esac',
        ].join('\n'),
      );
      const add = (n: string) => gitWith(env, work, 'worktree', 'add', path.join(root, `wt-${n}`), '-b', `${n}-x`);
      const unread = add('14');
      assert.equal(unread.status, 0);
      assert.match(unread.stderr, /#14 を引けなかった.*Bad credentials/);
      const unwritten = add('16');
      assert.equal(unwritten.status, 0);
      assert.match(unwritten.stderr, /#16 に status:in-progress を付けられませんでした.*Validation Failed/);
      // git だけを置いた PATH で、gh が見つからない状態を作る
      const bin = path.join(root, 'git-only-bin');
      mkdirSync(bin);
      const gitPath = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
      symlinkSync(realpathSync(gitPath), path.join(bin, 'git'));
      const missing = gitWith({ PATH: bin }, work, 'worktree', 'add', path.join(root, 'wt-15'), '-b', '15-x');
      assert.equal(missing.status, 0);
      assert.match(missing.stderr, /gh が無いので、#15/);
    });
  });
});
