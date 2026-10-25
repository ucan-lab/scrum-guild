import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

    describe('.dev.vars', () => {
      // 番号の無いブランチで切るので gh は呼ばれないが、呼ばれても本物の GitHub に書かないよう、失敗するだけの gh を先頭に置く
      const failingGh = (name: string) => fakeGh(name, 'exit 1');
      // 本体の根は .dev.vars.example の有無で確かめる。.dev.vars の中身は読まないので、置くのは仮の値
      const setUpMain = (name: string, withDevVars: boolean) => {
        const work = setUp(name);
        writeFileSync(path.join(work, '.dev.vars.example'), '# 例\n');
        if (withDevVars) writeFileSync(path.join(work, '.dev.vars'), 'PLACEHOLDER=1\n');
        return work;
      };

      test('本体に .dev.vars があれば、ワークツリーの .dev.vars を本体へのリンクにする', () => {
        const work = setUpMain('dv-link', true);
        const env = failingGh('dv-link');
        const wt = path.join(root, 'wt-dv-link');
        const added = gitWith(env, work, 'worktree', 'add', wt, '-b', 'feature-dv');
        assert.equal(added.status, 0);
        assert.match(added.stderr, /\.dev\.vars を本体.*へのリンクにしました/);
        assert.equal(readlinkSync(path.join(wt, '.dev.vars')), path.join(realpathSync(work), '.dev.vars'));
        // 番号付きのブランチでも置く。Issue の判定には進む（ここでは gh が失敗する）
        const wtNumbered = path.join(root, 'wt-dv-link-12');
        const numbered = gitWith(env, work, 'worktree', 'add', wtNumbered, '-b', '12-dv');
        assert.equal(numbered.status, 0);
        assert.match(numbered.stderr, /\.dev\.vars を本体/);
        assert.match(numbered.stderr, /#12 を引けなかった/);
        assert.equal(readlinkSync(path.join(wtNumbered, '.dev.vars')), path.join(realpathSync(work), '.dev.vars'));
      });

      // チェックアウトした時点で .dev.vars が既にあるブランチを作る（追跡したファイルは checkout が置く）
      const branchWithDevVars = (work: string, branch: string, place: (file: string) => void) => {
        git(work, 'checkout', '-q', '-b', `${branch}-base`);
        place(path.join(work, '.dev.vars'));
        git(work, 'add', '-f', '.dev.vars');
        assert.equal(git(work, 'commit', '-q', '-m', 'dev.vars').status, 0);
        git(work, 'branch', branch);
        git(work, 'checkout', '-q', 'main');
      };

      test('ワークツリーに .dev.vars が既にあれば、触らない', () => {
        const work = setUpMain('dv-keep', true);
        const env = failingGh('dv-keep');
        rmSync(path.join(work, '.dev.vars'));
        branchWithDevVars(work, 'feature-file', (file) => writeFileSync(file, 'TRACKED=1\n'));
        const wt = path.join(root, 'wt-dv-file');
        const added = gitWith(env, work, 'worktree', 'add', wt, 'feature-file');
        assert.equal(added.status, 0);
        assert.doesNotMatch(added.stderr, /\.dev\.vars/);
        assert.equal(lstatSync(path.join(wt, '.dev.vars')).isSymbolicLink(), false);
        assert.equal(readFileSync(path.join(wt, '.dev.vars'), 'utf8'), 'TRACKED=1\n');
      });

      test('壊れたリンクの .dev.vars も触らない', () => {
        const work = setUpMain('dv-broken', true);
        const env = failingGh('dv-broken');
        rmSync(path.join(work, '.dev.vars'));
        branchWithDevVars(work, 'feature-broken', (file) => symlinkSync('/nonexistent/dev-vars', file));
        const wt = path.join(root, 'wt-dv-broken');
        const added = gitWith(env, work, 'worktree', 'add', wt, 'feature-broken');
        assert.equal(added.status, 0);
        assert.doesNotMatch(added.stderr, /\.dev\.vars/);
        assert.equal(readlinkSync(path.join(wt, '.dev.vars')), '/nonexistent/dev-vars');
      });

      test('本体に .dev.vars が無ければ、リンクを置かずに案内し、ワークツリーは作る', () => {
        const work = setUpMain('dv-none', false);
        const env = failingGh('dv-none');
        const wt = path.join(root, 'wt-dv-none');
        const added = gitWith(env, work, 'worktree', 'add', wt, '-b', 'feature-none');
        assert.equal(added.status, 0);
        assert.match(added.stderr, /本体に \.dev\.vars が無いので、リンクを置いていません.*\.dev\.vars\.example/);
        assert.throws(() => lstatSync(path.join(wt, '.dev.vars')), { code: 'ENOENT' });
        // 本体にもファイルを作らない
        assert.throws(() => lstatSync(path.join(work, '.dev.vars')), { code: 'ENOENT' });
      });

      test('本体の作業コピー（追加のワークツリーでない）では動かない', () => {
        // 本体に .dev.vars が無い clone で、追加のワークツリーと取り違えると「本体に .dev.vars が無い」の案内が出る。出ないことで判定を見る
        const work = setUpMain('dv-main', false);
        const env = failingGh('dv-main');
        // setUp が core.hooksPath を設定済みなので、フックを切って example を push する（main の上のコミットと push はフックが止める）
        const noHooks = ['-c', 'core.hooksPath=/dev/null'];
        assert.equal(git(work, ...noHooks, 'add', '.dev.vars.example').status, 0);
        assert.equal(git(work, ...noHooks, 'commit', '-q', '-m', 'example').status, 0);
        assert.equal(git(work, ...noHooks, 'push', 'origin', 'main').status, 0);
        // clone は前の HEAD が null の SHA になるが、追加のワークツリーではないので、.dev.vars を置かず案内も出さない
        const remote = path.join(root, 'dv-main.git');
        const clone = path.join(root, 'dv-main-clone');
        const cloned = gitWith(env, root, '-c', `core.hooksPath=${hooksDir}`, 'clone', remote, clone);
        assert.equal(cloned.status, 0);
        assert.equal(lstatSync(path.join(clone, '.dev.vars.example')).isFile(), true);
        assert.doesNotMatch(cloned.stderr, /\.dev\.vars/);
        assert.throws(() => lstatSync(path.join(clone, '.dev.vars')), { code: 'ENOENT' });
      });

      test('detached のワークツリーと、gh の無い環境でも、リンクを置く', () => {
        const work = setUpMain('dv-env', true);
        const env = failingGh('dv-env');
        const expected = path.join(realpathSync(work), '.dev.vars');
        const detached = path.join(root, 'wt-dv-detached');
        assert.equal(gitWith(env, work, 'worktree', 'add', detached, '--detach').status, 0);
        assert.equal(readlinkSync(path.join(detached, '.dev.vars')), expected);
        // git とフックの使う道具だけを置いた PATH。gh は無い
        const bin = path.join(root, 'dv-tools-bin');
        mkdirSync(bin);
        for (const tool of ['git', 'dirname', 'basename', 'ln']) {
          const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
          symlinkSync(realpathSync(found), path.join(bin, tool));
        }
        const noGh = path.join(root, 'wt-dv-nogh');
        const added = gitWith({ PATH: bin }, work, 'worktree', 'add', noGh, '-b', '15-dv');
        assert.equal(added.status, 0);
        assert.match(added.stderr, /\.dev\.vars を本体/);
        assert.match(added.stderr, /gh が無いので、#15/);
        assert.equal(readlinkSync(path.join(noGh, '.dev.vars')), expected);
      });

      test('共通のディレクトリが .git でない（bare の配置）ときは、親を本体と取り違えない', () => {
        setUp('dv-bare-src');
        const env = failingGh('dv-bare');
        // bare リポジトリの親に .dev.vars.example と .dev.vars があっても、本体とはみなさない
        const parent = path.join(root, 'dv-bare');
        mkdirSync(parent);
        writeFileSync(path.join(parent, '.dev.vars.example'), '# 例\n');
        writeFileSync(path.join(parent, '.dev.vars'), 'PLACEHOLDER=1\n');
        const bare = path.join(parent, 'repo.git');
        assert.equal(git(root, 'clone', '--bare', path.join(root, 'dv-bare-src.git'), bare).status, 0);
        const wt = path.join(parent, 'wt');
        const added = gitWith(
          env,
          bare,
          '-c',
          `core.hooksPath=${hooksDir}`,
          'worktree',
          'add',
          wt,
          '-b',
          'feature-bare',
          'main',
        );
        assert.equal(added.status, 0);
        assert.doesNotMatch(added.stderr, /\.dev\.vars/);
        assert.throws(() => lstatSync(path.join(wt, '.dev.vars')), { code: 'ENOENT' });
      });

      test('本体の根を確かめられない（.dev.vars.example が無い）ときは、何もしない', () => {
        const work = setUp('dv-noexample');
        const env = failingGh('dv-noexample');
        const wt = path.join(root, 'wt-dv-noexample');
        const added = gitWith(env, work, 'worktree', 'add', wt, '-b', 'feature-noexample');
        assert.equal(added.status, 0);
        assert.doesNotMatch(added.stderr, /\.dev\.vars/);
        assert.throws(() => lstatSync(path.join(wt, '.dev.vars')), { code: 'ENOENT' });
      });
    });
  });
});
