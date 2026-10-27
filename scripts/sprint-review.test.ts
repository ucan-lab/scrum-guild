import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// sprint-review で、セッションが Issue の受け入れ条件に印を付けるスクリプト
describe('check-criterion.py', () => {
  const script = fileURLToPath(new URL('../.claude/skills/sprint-review/check-criterion.py', import.meta.url));

  const spawn = (body: string, args: (dir: string) => string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'check-criterion-'));
    try {
      writeFileSync(join(dir, 'body.md'), body);
      const result = spawnSync('python3', ['-I', script, ...args(dir)], { encoding: 'utf8' });
      // python3 が無い環境では spawnSync が error を返す。終了コードの食い違いより先に原因を出す
      assert.ifError(result.error);
      const outPath = join(dir, 'out.md');
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        out: existsSync(outPath) ? readFileSync(outPath, 'utf8') : undefined,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const run = (body: string, criterion: string) =>
    spawn(body, (dir) => [join(dir, 'body.md'), criterion, join(dir, 'out.md')]);
  const ok = (body: string, criterion: string) => {
    const result = run(body, criterion);
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(result.out, undefined);
    return { out: result.out as string, stdout: result.stdout };
  };
  const refused = (body: string, criterion: string) => {
    const result = run(body, criterion);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.out, undefined, '断るときは出力を書かない');
    return result.stderr;
  };

  const body = [
    '## 受け入れ条件',
    '',
    '- [ ] `/sprint-review` で、受け入れ待ちの一覧が出る',
    '- [ ] 見つけたことが最後にまとめて起票の候補として出る',
    '- [x] 終わりに片付けが報告される',
    '',
    '## やること',
    '',
    '- 印の無いリストの行は数えない（受け入れ待ち）',
  ].join('\n');

  test('当たる未チェックの行が1行なら、その行の `[ ]` だけに印を付ける', () => {
    const { out, stdout } = ok(body, '起票の候補');
    assert.equal(out, body.replace('- [ ] 見つけたことが最後にまとめて', '- [x] 見つけたことが最後にまとめて'));
    assert.match(stdout, /本文を書き換える\n$/);
  });

  test('インデントのある行と `*` と `+` の印の行にも付ける', () => {
    const nested = ['- [ ] 親の条件', '  * [ ] 子の条件 A', '    + [ ] 孫の条件 B'].join('\n');
    assert.equal(ok(nested, '条件 A').out, nested.replace('* [ ] 子', '* [x] 子'));
    assert.equal(ok(nested, '条件 B').out, nested.replace('+ [ ] 孫', '+ [x] 孫'));
  });

  test('同じ条件に既に印があれば、本文をそのまま書いて「本文は変わらない」で終わる', () => {
    for (const mark of ['x', 'X']) {
      const checked = body.replace('- [x] 終わりに', `- [${mark}] 終わりに`);
      const { out, stdout } = ok(checked, '片付け');
      assert.equal(out, checked);
      assert.match(stdout, /本文は変わらない\n$/);
    }
  });

  test('当たる行が無ければ断る。印の無いリストの行と `[ ]` の後に文の無い行は数えない', () => {
    assert.match(refused(body, '存在しない条件'), /無い/);
    assert.match(refused(body, '印の無いリスト'), /無い/);
    refused('- [ ]\n- [ ]   \n-[ ] 詰めた印\n', '詰めた');
  });

  test('当たる未チェックの行が2行以上なら、候補を並べて断る', () => {
    const stderr = refused(body, '出る');
    assert.ok(stderr.includes('- [ ] `/sprint-review` で、受け入れ待ちの一覧が出る'), stderr);
    assert.ok(stderr.includes('- [ ] 見つけたことが最後にまとめて起票の候補として出る'), stderr);
  });

  test('チェック済みと未チェックが1行ずつなら、未チェックの行に印を付ける', () => {
    const both = ['- [x] 一覧が出る（本番）', '- [ ] 一覧が出る（手元）'].join('\n');
    const { out, stdout } = ok(both, '一覧が出る');
    assert.equal(out, ['- [x] 一覧が出る（本番）', '- [x] 一覧が出る（手元）'].join('\n'));
    assert.match(stdout, /本文を書き換える\n$/);
  });

  test('フェンスのコードブロックの中の行は数えない', () => {
    const fenced = [
      '```markdown',
      '- [ ] 一覧が出る（例）',
      '~~~',
      '- [ ] 一覧が出る（まだ ``` の中）',
      '```',
      '- [ ] 一覧が出る',
      '~~~~',
      '- [x] 片付けが報告される',
      '```',
      '- [ ] 片付けが報告される（まだ ~~~~ の中）',
      '~~~~',
    ].join('\n');
    assert.equal(ok(fenced, '一覧が出る').out, fenced.replace('```\n- [ ] 一覧が出る\n', '```\n- [x] 一覧が出る\n'));
    // ブロックの中の印のある行は、既に印があるとは数えない
    refused(fenced, '片付けが報告される');
  });

  test('`\\r\\n` と末尾の改行の有無を変えない', () => {
    for (const tail of ['', '\r\n']) {
      const crlf = `${body.replace(/\n/g, '\r\n')}${tail}`;
      assert.equal(ok(crlf, '起票の候補').out, crlf.replace('- [ ] 見つけた', '- [x] 見つけた'));
      assert.equal(ok(crlf, '片付け').out, crlf);
    }
    const lf = `${body}\n`;
    assert.equal(ok(lf, '起票の候補').out, lf.replace('- [ ] 見つけた', '- [x] 見つけた'));
  });

  test('引数の数が違えば、使い方を出して終了コード 2', () => {
    for (const args of [(dir: string) => [join(dir, 'body.md'), '一覧'], () => []]) {
      const result = spawn(body, args);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /使い方/);
    }
    const extra = spawn(body, (dir) => [join(dir, 'body.md'), '一覧', join(dir, 'out.md'), '余り']);
    assert.equal(extra.status, 2);
    assert.equal(extra.out, undefined);
  });

  test('条件の文字列が空か空白だけなら、終了コード 2 で出力を書かない', () => {
    for (const criterion of ['', ' ', ' \t ']) {
      const result = run(body, criterion);
      assert.equal(result.status, 2);
      assert.equal(result.out, undefined);
    }
  });
});
