import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  commentEntry,
  flattenPages,
  formatReport,
  isTrustedComment,
  MAX_FILE_BYTES,
  renderBody,
  renderComments,
  sortByCreatedAt,
  truncateUtf8,
  writeContext,
  type ContextComment,
} from './ai-review-context.ts';

function comment(overrides: Partial<ContextComment> & { id: number }): ContextComment {
  return {
    body: `本文 ${overrides.id}`,
    created_at: '2026-10-29T00:00:00Z',
    author_association: 'OWNER',
    user: { login: 'aoba', type: 'User' },
    ...overrides,
  };
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe('isTrustedComment', () => {
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    test(`${association} は残す`, () => {
      assert.equal(isTrustedComment(comment({ id: 1, author_association: association })), true);
    });
  }

  for (const association of ['CONTRIBUTOR', 'NONE', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'MANNEQUIN']) {
    test(`${association} は落とす`, () => {
      assert.equal(isTrustedComment(comment({ id: 1, author_association: association })), false);
    });
  }

  test('区分が無いものは落とす', () => {
    assert.equal(isTrustedComment(comment({ id: 1, author_association: null })), false);
    assert.equal(isTrustedComment(comment({ id: 1, author_association: undefined })), false);
  });

  test('github-actions[bot] の Bot 型は、区分が NONE でも残す', () => {
    const bot = comment({
      id: 1,
      author_association: 'NONE',
      user: { login: 'github-actions[bot]', type: 'Bot' },
    });
    assert.equal(isTrustedComment(bot), true);
  });

  test('bot の名前を名乗る User 型は、区分が NONE なら落とす', () => {
    const fake = comment({
      id: 1,
      author_association: 'NONE',
      user: { login: 'github-actions[bot]', type: 'User' },
    });
    assert.equal(isTrustedComment(fake), false);
  });

  test('ほかの Bot は落とす', () => {
    for (const login of ['dependabot[bot]', 'claude[bot]']) {
      const other = comment({ id: 1, author_association: 'NONE', user: { login, type: 'Bot' } });
      assert.equal(isTrustedComment(other), false, login);
    }
  });
});

describe('sortByCreatedAt', () => {
  test('古い順に並べ、入力は変えない', () => {
    const input = [
      comment({ id: 3, created_at: '2026-10-29T03:00:00Z' }),
      comment({ id: 1, created_at: '2026-10-29T01:00:00Z' }),
      comment({ id: 2, created_at: '2026-10-29T02:00:00Z' }),
    ];
    assert.deepEqual(
      sortByCreatedAt(input).map((c) => c.id),
      [1, 2, 3],
    );
    assert.deepEqual(
      input.map((c) => c.id),
      [3, 1, 2],
    );
  });

  test('同時刻は id の小さい方が先', () => {
    const input = [comment({ id: 9 }), comment({ id: 4 })];
    assert.deepEqual(
      sortByCreatedAt(input).map((c) => c.id),
      [4, 9],
    );
  });
});

describe('flattenPages', () => {
  test('--slurp のページの配列を1つにする', () => {
    const pages = [[comment({ id: 1 })], [comment({ id: 2 }), comment({ id: 3 })], []];
    assert.deepEqual(
      flattenPages(pages).map((c) => c.id),
      [1, 2, 3],
    );
  });

  test('ならした配列はそのまま', () => {
    assert.deepEqual(
      flattenPages([comment({ id: 1 })]).map((c) => c.id),
      [1],
    );
  });

  test('配列でなければ投げる', () => {
    assert.throws(() => flattenPages({ message: 'Not Found' }), /配列ではありません/);
  });
});

describe('commentEntry', () => {
  test('PR 全体のコメントの見出しは、書いた人、区分、id、時刻', () => {
    const entry = commentEntry(comment({ id: 42, created_at: '2026-10-29T01:02:03Z', body: 'やあ' }));
    assert.match(entry, /^\n## aoba \[OWNER\] id=42 2026-10-29T01:02:03Z\n\n> やあ\n$/);
  });

  test('Bot は区分に Bot を添える', () => {
    const entry = commentEntry(
      comment({ id: 1, author_association: 'NONE', user: { login: 'github-actions[bot]', type: 'Bot' } }),
    );
    assert.match(entry, /## github-actions\[bot\] \[NONE, Bot\] id=1/);
  });

  test('インラインは path:line と in_reply_to_id を付ける', () => {
    const entry = commentEntry(comment({ id: 5, path: 'src/a.ts', line: 12, in_reply_to_id: 4 }));
    assert.match(entry, /\n場所: src\/a\.ts:12 in_reply_to_id=4\n/);
  });

  test('返信でなければ in_reply_to_id を付けない', () => {
    const entry = commentEntry(comment({ id: 5, path: 'src/a.ts', line: 12, in_reply_to_id: null }));
    assert.match(entry, /\n場所: src\/a\.ts:12\n/);
    assert.doesNotMatch(entry, /in_reply_to_id/);
  });

  test('line が null なら original_line を使う', () => {
    const entry = commentEntry(comment({ id: 5, path: 'src/a.ts', line: null, original_line: 7 }));
    assert.match(entry, /\n場所: src\/a\.ts:7（古い版の行）\n/);
  });

  test('line も original_line も null ならファイル単位', () => {
    const entry = commentEntry(comment({ id: 5, path: 'src/a.ts', line: null, original_line: null }));
    assert.match(entry, /\n場所: src\/a\.ts（ファイル単位）\n/);
  });

  test('本文の見出しを、コメントの境目に見せない', () => {
    const entry = commentEntry(comment({ id: 5, body: '## 偽の見出し\n\n行2' }));
    assert.doesNotMatch(entry, /^## 偽の見出し/m);
    assert.match(entry, /> ## 偽の見出し\n>\n> 行2/);
  });

  test('本文が null でも落ちない', () => {
    assert.match(commentEntry(comment({ id: 5, body: null })), /id=5/);
  });
});

describe('renderComments', () => {
  test('区分で落とした件数を冒頭に書き、残したものを古い順に並べる', () => {
    const result = renderComments('PR 全体のコメント', [
      comment({ id: 2, created_at: '2026-10-29T02:00:00Z' }),
      comment({ id: 9, author_association: 'NONE', user: { login: 'stranger', type: 'User' } }),
      comment({ id: 1, created_at: '2026-10-29T01:00:00Z', author_association: 'MEMBER' }),
      comment({ id: 8, author_association: 'FIRST_TIMER', user: { login: 'newbie', type: 'User' } }),
    ]);
    assert.equal(result.kept, 2);
    assert.equal(result.droppedByAssociation, 2);
    assert.equal(result.droppedByLimit, 0);
    assert.match(result.text, /^# PR 全体のコメント\n/);
    assert.match(result.text, /- 残した件数: 2\n/);
    assert.match(result.text, /- 区分で落とした件数: 2\n/);
    assert.match(result.text, /- 上限（64KB）で落とした件数: 0\n/);
    assert.ok(result.text.indexOf('id=1 ') < result.text.indexOf('id=2 '));
    assert.doesNotMatch(result.text, /stranger|newbie/);
  });

  test('コメントが無くても冒頭は書く', () => {
    const result = renderComments('PR 全体のコメント', []);
    assert.equal(result.kept, 0);
    assert.match(result.text, /- 残した件数: 0\n/);
  });

  test('上限を超えたら後ろ（新しい側）のコメントを落とし、件数を書く', () => {
    const body = 'あ'.repeat(1000);
    const comments = Array.from({ length: 10 }, (_, i) =>
      comment({ id: i + 1, body, created_at: `2026-10-29T00:00:${String(i).padStart(2, '0')}Z` }),
    );
    const entrySize = bytes(commentEntry(comments[0]!));
    const limit = 400 + entrySize * 3;
    const result = renderComments('PR 全体のコメント', comments, limit);
    assert.ok(bytes(result.text) <= limit);
    assert.equal(result.kept, 3);
    assert.equal(result.droppedByLimit, 7);
    assert.match(result.text, /- 残した件数: 3\n/);
    assert.match(result.text, /- 上限（64KB）で落とした件数: 7\n/);
    assert.match(result.text, /id=1 /);
    assert.match(result.text, /id=3 /);
    assert.doesNotMatch(result.text, /id=4 /);
  });

  test('上限に収まる最大の件数を残す（1件増やすと超える）', () => {
    const comments = Array.from({ length: 6 }, (_, i) =>
      comment({ id: i + 1, body: 'x'.repeat(500), created_at: `2026-10-29T00:00:0${i}Z` }),
    );
    const limit = 2500;
    const result = renderComments('t', comments, limit);
    assert.ok(bytes(result.text) <= limit);
    const more = renderComments('t', comments.slice(0, result.kept + 1), 1e9);
    assert.ok(bytes(more.text) > limit);
  });

  test('バイト数で数える（日本語は1文字3バイト）', () => {
    // 文字数なら 600 文字 x 2 件で 1200 だが、バイト数では 1800 x 2 になる
    const comments = [
      comment({ id: 1, body: 'あ'.repeat(600), created_at: '2026-10-29T00:00:01Z' }),
      comment({ id: 2, body: 'あ'.repeat(600), created_at: '2026-10-29T00:00:02Z' }),
    ];
    const limit = 2500;
    const result = renderComments('t', comments, limit);
    assert.equal(result.kept, 1);
    assert.equal(result.droppedByLimit, 1);
    assert.ok(bytes(result.text) <= limit);
    assert.ok(result.text.length < limit, '文字数では上限に届かない');
  });

  test('1件目が単独で上限を超えるなら、すべて上限で落とす', () => {
    const result = renderComments('t', [comment({ id: 1, body: 'x'.repeat(5000) })], 1000);
    assert.equal(result.kept, 0);
    assert.equal(result.droppedByLimit, 1);
    assert.ok(bytes(result.text) <= 1000);
  });

  test('既定の上限は 64KB', () => {
    assert.equal(MAX_FILE_BYTES, 65536);
    const comments = Array.from({ length: 100 }, (_, i) =>
      comment({
        id: i + 1,
        body: 'x'.repeat(2000),
        created_at: `2026-10-29T00:00:${String(i % 60).padStart(2, '0')}Z`,
      }),
    );
    const result = renderComments('t', comments);
    assert.ok(bytes(result.text) <= MAX_FILE_BYTES);
    assert.ok(result.droppedByLimit > 0);
    assert.equal(result.kept + result.droppedByLimit, 100);
  });
});

describe('truncateUtf8', () => {
  test('収まるならそのまま', () => {
    assert.equal(truncateUtf8('あい', 6), 'あい');
  });

  test('マルチバイトの文字の途中では切らない', () => {
    assert.equal(truncateUtf8('あいう', 7), 'あい');
    assert.equal(truncateUtf8('あいう', 8), 'あい');
    assert.equal(truncateUtf8('あいう', 2), '');
    assert.equal(truncateUtf8('a😀b', 4), 'a');
    assert.equal(truncateUtf8('a😀b', 5), 'a😀');
  });

  test('結果は上限のバイト数に収まり、置換文字を含まない', () => {
    for (let max = 0; max < 20; max++) {
      const out = truncateUtf8('あa😀いb', max);
      assert.ok(bytes(out) <= max);
      assert.ok(!out.includes('�'));
    }
  });
});

describe('renderBody', () => {
  test('本文は区分で絞らず、そのまま書く', () => {
    const result = renderBody({ body: '## 概要\nなぜこうしたか', user: { login: 'aoba' } });
    assert.equal(result.truncated, false);
    assert.match(result.text, /^# PR の本文\n/);
    assert.match(result.text, /- 作成者: aoba\n/);
    assert.match(result.text, /- 残した件数: 1\n/);
    assert.match(result.text, /- 区分で落とした件数: 0\n/);
    assert.match(result.text, /- 切り詰め: なし\n/);
    assert.ok(result.text.endsWith('## 概要\nなぜこうしたか'));
  });

  test('本文が null でも書ける', () => {
    const result = renderBody({ body: null, user: { login: 'aoba' } });
    assert.equal(result.truncated, false);
    assert.match(result.text, /- 切り詰め: なし/);
  });

  test('上限を超えたら切り詰めて、切り詰めたことを書く', () => {
    const limit = 1000;
    const result = renderBody({ body: 'あ'.repeat(2000), user: { login: 'aoba' } }, limit);
    assert.equal(result.truncated, true);
    assert.ok(bytes(result.text) <= limit);
    assert.match(result.text, /- 切り詰め: あり（元は 6000 バイト。上限 1000 バイトまでで切った）/);
    assert.ok(!result.text.includes('�'));
  });

  test('ちょうど上限なら切り詰めない', () => {
    const body = 'x'.repeat(100);
    const result = renderBody({ body }, 100);
    assert.equal(result.truncated, false);
    assert.ok(result.text.endsWith(body));
  });
});

describe('formatReport', () => {
  test('件数だけを出し、本文は含めない', () => {
    const line = formatReport({ file: 'comments.md', kept: 3, droppedByAssociation: 2, droppedByLimit: 1 });
    assert.equal(line, 'comments.md: 残した 3 件、区分で落とした 2 件、上限で落とした 1 件');
  });
});

describe('writeContext と直接の実行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-review-context-'));
  const outDir = join(mkdtempSync(join(tmpdir(), 'ai-review-context-out-')), 'pr-context');
  writeFileSync(join(dir, 'pr.json'), JSON.stringify({ body: '本文です', user: { login: 'aoba', type: 'User' } }));
  writeFileSync(
    join(dir, 'issue-comments.json'),
    JSON.stringify([
      [comment({ id: 1, body: '秘密の本文A' }), comment({ id: 2, author_association: 'NONE', body: '秘密の本文B' })],
      [comment({ id: 3, body: '秘密の本文C', created_at: '2026-10-29T05:00:00Z' })],
    ]),
  );
  writeFileSync(
    join(dir, 'review-comments.json'),
    JSON.stringify([[comment({ id: 10, path: 'src/a.ts', line: null, original_line: null, body: '意図' })]]),
  );

  test('書き出す側に3つのファイルだけを書き、件数の報告を返す', () => {
    const reports = writeContext(dir, outDir);
    assert.deepEqual(
      reports.map((r) => [r.file, r.kept, r.droppedByAssociation, r.droppedByLimit]),
      [
        ['body.md', 1, 0, 0],
        ['comments.md', 2, 1, 0],
        ['review-comments.md', 1, 0, 0],
      ],
    );
    assert.ok(readFileSync(join(outDir, 'body.md'), 'utf8').endsWith('本文です'));
    assert.match(readFileSync(join(outDir, 'comments.md'), 'utf8'), /id=3 /);
    assert.match(readFileSync(join(outDir, 'review-comments.md'), 'utf8'), /src\/a\.ts（ファイル単位）/);
    // 絞る前の JSON（落としたコメントを含む）は、Claude が読む側に置かない
    assert.deepEqual(readdirSync(outDir).sort(), ['body.md', 'comments.md', 'review-comments.md']);
    assert.doesNotMatch(readFileSync(join(outDir, 'comments.md'), 'utf8'), /秘密の本文B/);
  });

  test('2つのディレクトリを引数で渡すと、件数だけを標準出力に出す（本文は出さない）', () => {
    const script = fileURLToPath(new URL('./ai-review-context.ts', import.meta.url));
    const run = spawnSync(process.execPath, [script, dir, outDir], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /comments\.md: 残した 2 件、区分で落とした 1 件、上限で落とした 0 件/);
    assert.doesNotMatch(run.stdout, /秘密の本文/);
  });

  test('書き出す側のディレクトリが無ければ失敗で終える', () => {
    const script = fileURLToPath(new URL('./ai-review-context.ts', import.meta.url));
    const run = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' });
    assert.equal(run.status, 1);
  });
});
