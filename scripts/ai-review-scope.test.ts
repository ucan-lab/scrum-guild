import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { chooseScope, extractMarkers, type Marker, noDiffBody, scopedDiff } from './ai-review-scope.ts';

const git = (dir: string, args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

// main に base のコミットを1つ置き、pr のブランチを切った状態の使い捨てのリポジトリ
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-review-scope-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'test']);
  writeFileSync(join(dir, 'shared.txt'), 'a\nb\nc\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['switch', '-qc', 'pr']);
  const commit = (file: string, text: string): string => {
    writeFileSync(join(dir, file), text);
    git(dir, ['add', file]);
    git(dir, ['commit', '-qm', file]);
    return git(dir, ['rev-parse', 'HEAD']);
  };
  const onMain = (file: string, text: string): string => {
    git(dir, ['switch', '-q', 'main']);
    const sha = commit(file, text);
    git(dir, ['switch', '-q', 'pr']);
    return sha;
  };
  const mainSha = () => git(dir, ['rev-parse', 'main']);
  return { dir, base, commit, onMain, mainSha };
}

const marker = (sha: string, source: Marker['source'] = 'done-check'): Marker => ({ sha, source, raw: '' });
const bot = { login: 'github-actions[bot]', type: 'Bot' };

describe('extractMarkers', () => {
  const sha = 'a'.repeat(40);

  test('PR の本文の done-check の印をすべて拾う', () => {
    const markers = extractMarkers(`x <!-- done-check:${sha} --> y <!-- done-check:${'b'.repeat(40)} -->`, []);
    assert.deepEqual(
      markers.map((m) => [m.source, m.sha]),
      [
        ['done-check', sha],
        ['done-check', 'b'.repeat(40)],
      ],
    );
  });

  test('ai-review の印は github-actions[bot] の Bot のコメントの先頭にあるものだけ拾う', () => {
    const markers = extractMarkers('', [
      [{ user: bot, body: `<!-- ai-review:${sha} -->\n本文` }],
      [
        { user: { login: 'person', type: 'User' }, body: `<!-- ai-review:${'1'.repeat(40)} -->` },
        { user: { login: 'github-actions[bot]', type: 'User' }, body: `<!-- ai-review:${'2'.repeat(40)} -->` },
        { user: { login: 'other[bot]', type: 'Bot' }, body: `<!-- ai-review:${'3'.repeat(40)} -->` },
        { user: bot, body: `前置き <!-- ai-review:${'4'.repeat(40)} -->` },
        { user: bot, body: ` <!-- ai-review:${'5'.repeat(40)} -->` },
      ],
    ]);
    assert.deepEqual(
      markers.map((m) => [m.source, m.sha]),
      [['ai-review', sha]],
    );
  });

  test('本文やコメントが文字列でなくても落ちない', () => {
    assert.deepEqual(extractMarkers(undefined, { not: 'array' }), []);
    assert.deepEqual(extractMarkers(null, [[{ user: bot, body: 1 }], [null]]), []);
  });
});

describe('chooseScope', () => {
  test('印が無ければ全体を見る', () => {
    const r = repo();
    const head = r.commit('one.txt', '1\n');
    const scope = chooseScope([], r.base, head, r.dir);
    assert.equal(scope.mode, 'full');
    assert.equal(scope.start, undefined);
    assert.equal(scope.reason, '印が無い');
  });

  test('done-check と ai-review の印のうち、head に近い方を起点にする（どちらが近くても）', () => {
    const r = repo();
    const first = r.commit('one.txt', '1\n');
    const second = r.commit('two.txt', '2\n');
    const head = r.commit('three.txt', '3\n');
    assert.equal(chooseScope([marker(first), marker(second, 'ai-review')], r.base, head, r.dir).start, second);
    assert.equal(chooseScope([marker(first, 'ai-review'), marker(second)], r.base, head, r.dir).start, second);
    assert.equal(chooseScope([marker(second), marker(first, 'ai-review')], r.base, head, r.dir).mode, 'since');
  });

  test('無い、head の祖先でない、main 上、形が不正な印を、それぞれの理由で退けて全体を見る', () => {
    const r = repo();
    const mainCommit = r.onMain('main.txt', 'm\n');
    git(r.dir, ['merge', '-q', '--no-edit', 'main']);
    const head = r.commit('one.txt', '1\n');
    git(r.dir, ['switch', '-qc', 'side', r.base]);
    const side = r.commit('side.txt', 's\n');
    git(r.dir, ['switch', '-q', 'pr']);
    const cases: [string, string][] = [
      ['f'.repeat(40), 'コミットが無い'],
      [side, 'head の祖先でない'],
      [r.base, 'main 上のコミット'],
      [mainCommit, 'main 上のコミット'],
      ['A'.repeat(40), 'SHA の形が不正'],
      ['a'.repeat(39), 'SHA の形が不正'],
      ['g'.repeat(40), 'SHA の形が不正'],
    ];
    const scope = chooseScope(
      cases.map(([sha]) => marker(sha)),
      r.mainSha(),
      head,
      r.dir,
    );
    assert.equal(scope.mode, 'full');
    assert.equal(scope.reason, 'すべての印が退けられた');
    assert.deepEqual(
      scope.rejected.map((x) => x.reason),
      cases.map(([, reason]) => reason),
    );
  });

  test('退けた印があっても、有効な印があればそこを起点にする', () => {
    const r = repo();
    const start = r.commit('one.txt', '1\n');
    const head = r.commit('two.txt', '2\n');
    const scope = chooseScope([marker('f'.repeat(40)), marker(start)], r.base, head, r.dir);
    assert.equal(scope.mode, 'since');
    assert.equal(scope.start, start);
    assert.equal(scope.rejected.length, 1);
  });
});

describe('scopedDiff', () => {
  test('起点の後の変更だけを、head 側の行番号で返す', () => {
    const r = repo();
    r.commit('one.txt', '1\n');
    const start = r.commit('two.txt', '2\n');
    const head = r.commit('two.txt', '2\n3\n');
    const result = scopedDiff(r.base, head, start, r.dir);
    assert.equal(result.files, 'M\ttwo.txt\n');
    assert.match(result.patch, /@@ -1 \+1,2 @@/);
    assert.doesNotMatch(result.patch, /one\.txt/);
    assert.deepEqual(result.conflicts, []);
  });

  test('起点の後に main を merge で取り込んでも、取り込んだ main の変更は入らない', () => {
    const r = repo();
    const start = r.commit('one.txt', '1\n');
    r.onMain('main.txt', 'm\n');
    git(r.dir, ['merge', '-q', '--no-edit', 'main']);
    const head = r.commit('変更.txt', 'pr\n');
    const result = scopedDiff(r.mainSha(), head, start, r.dir);
    assert.equal(result.files, 'A\t変更.txt\n');
    assert.doesNotMatch(result.patch, /main\.txt/);
    assert.equal(result.empty, false);
  });

  test('取り込みで衝突したファイルは merge-base から head の全体の差分で渡す', () => {
    const r = repo();
    const start = r.commit('shared.txt', 'a\nPR\nc\n');
    r.onMain('shared.txt', 'a\nMAIN\nc\n');
    spawnSync('git', ['merge', '-q', '--no-edit', 'main'], { cwd: r.dir });
    writeFileSync(join(r.dir, 'shared.txt'), 'a\nPR+MAIN\nc\n');
    git(r.dir, ['commit', '-qam', 'merge']);
    const head = r.commit('other.txt', 'o\n');
    const result = scopedDiff(r.mainSha(), head, start, r.dir);
    assert.deepEqual(result.conflicts, ['shared.txt']);
    assert.doesNotMatch(result.patch, /<<<<<<<|>>>>>>>/);
    assert.match(result.patch, /-MAIN\n\+PR\+MAIN/);
    assert.equal(result.files.split('\n').filter(Boolean).sort().join('\n'), 'A\tother.txt\nM\tshared.txt');
  });

  test('起点が head なら空', () => {
    const r = repo();
    const head = r.commit('one.txt', '1\n');
    const result = scopedDiff(r.base, head, head, r.dir);
    assert.equal(result.empty, true);
    assert.equal(result.patch, '');
    assert.equal(result.files, '');
  });
});

test('差分なしのコメントは決まった1行で、印を含まない', () => {
  const body = noDiffBody('a'.repeat(40));
  assert.equal(body, `AI レビュー: 起点 \`${'a'.repeat(40)}\` から差分が無いので見ない。`);
  assert.doesNotMatch(body, /<!-- ai-review:/);
});

describe('ai-review-scope.ts を直に走らせる', () => {
  const script = fileURLToPath(new URL('./ai-review-scope.ts', import.meta.url));

  function runCli(opts: { body?: string; comments?: unknown; action: string; noRaw?: boolean; head?: 'same' }) {
    const r = repo();
    const first = r.commit('one.txt', '1\n');
    const start = r.commit('two.txt', '2\n');
    const head = opts.head === 'same' ? start : r.commit('two.txt', '2\n3\n');
    const raw = join(r.dir, '.raw');
    const context = join(r.dir, '.context');
    const output = join(r.dir, '.output');
    const noDiff = join(r.dir, '.none.md');
    if (!opts.noRaw) {
      mkdirSync(raw);
      writeFileSync(join(raw, 'pr.json'), JSON.stringify({ body: (opts.body ?? '').replace('START', start) }));
      writeFileSync(join(raw, 'issue-comments.json'), JSON.stringify(opts.comments ?? [[]]));
    }
    const result = spawnSync(process.execPath, [script], {
      cwd: r.dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        RAW_DIR: raw,
        CONTEXT_DIR: context,
        BASE_SHA: r.base,
        HEAD_SHA: head,
        EVENT_ACTION: opts.action,
        NO_DIFF_BODY_FILE: noDiff,
        GITHUB_OUTPUT: output,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const read = (p: string) => readFileSync(p, 'utf8');
    return {
      first,
      start,
      scope: read(join(context, 'scope.md')),
      patch: read(join(context, 'diff.patch')),
      files: read(join(context, 'files.txt')),
      output: read(output),
      noDiff: existsSync(noDiff) ? read(noDiff) : undefined,
    };
  }

  test('印が無ければ全体の差分を書き、mode=full を出す', () => {
    const out = runCli({ action: 'ready_for_review' });
    assert.equal(out.output, 'mode=full\nstart=\n');
    assert.match(out.scope, /方式: 全体/);
    assert.equal(out.files, 'A\tone.txt\nA\ttwo.txt\n');
    assert.equal(out.noDiff, undefined);
  });

  test('pr-raw が無くても落ちず、全体を見る', () => {
    const out = runCli({ action: 'opened', noRaw: true });
    assert.match(out.output, /^mode=full\n/);
  });

  test('done-check の印から差分があれば、その差分だけを書く', () => {
    const out = runCli({ body: '<!-- done-check:START -->', action: 'ready_for_review' });
    assert.equal(out.output, `mode=since\nstart=${out.start}\n`);
    assert.match(out.scope, /方式: 起点から/);
    assert.ok(out.scope.includes(out.start));
    assert.equal(out.files, 'M\ttwo.txt\n');
  });

  for (const action of ['opened', 'reopened', 'ready_for_review']) {
    test(`起点から差分が無ければ、${action} では none にし、決まった文を書く`, () => {
      const out = runCli({ body: '<!-- done-check:START -->', action, head: 'same' });
      assert.equal(out.output, `mode=none\nstart=${out.start}\n`);
      assert.equal(out.noDiff, noDiffBody(out.start));
      assert.match(out.scope, /方式: 差分なし/);
    });
  }

  test('起点から差分が無くても、labeled では全体を見て理由を書く', () => {
    const out = runCli({ body: '<!-- done-check:START -->', action: 'labeled', head: 'same' });
    assert.match(out.output, /^mode=full\n/);
    assert.match(out.scope, /ラベルで回したので全体を見る/);
    assert.equal(out.files, 'A\tone.txt\nA\ttwo.txt\n');
    assert.equal(out.noDiff, undefined);
  });

  test('退けた印は理由とともに scope.md に書く', () => {
    const out = runCli({ body: `<!-- done-check:${'f'.repeat(40)} -->`, action: 'opened' });
    assert.match(out.output, /^mode=full\n/);
    assert.match(out.scope, /コミットが無い/);
  });
});
