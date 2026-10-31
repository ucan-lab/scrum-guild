import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { noDiffBody } from './ai-review-scope.ts';

// CI の ai-review は、PR 本文の done-check の印と前のまとめの印から後の差分だけを見る（scripts/ai-review-scope.ts）。
// 印を書く、残す、直しの後にラベルを1回付ける決まりはスキルの文言にしか無いので、文言が消えたら落とす
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const prCreate = read('.claude/skills/pr-create/SKILL.md');
const prFeedback = read('.claude/skills/pr-feedback/SKILL.md');
const doneCheck = read('.claude/skills/done-check/SKILL.md');
const development = read('docs/development.md');

const MARK = '<!-- done-check:<完全な SHA> -->';
const MARK_ANY = '`<!-- done-check:<SHA> -->`';

describe('done-check の印を書く', () => {
  test('ai-review-scope.ts が拾う形と、pr-create が書く形が同じ', () => {
    const scope = read('scripts/ai-review-scope.ts');
    assert.ok(scope.includes('/<!-- done-check:([^>\\s]+) -->/g'), 'ai-review-scope.ts の印の形が変わった');
    assert.ok(prCreate.includes(`\`${MARK}\``), 'pr-create が印を書いていない');
  });

  test('pr-create は done-check の出力の「点検した head」を書き、push した head と違えば書かない', () => {
    assert.ok(prCreate.includes('### done-check の印'));
    assert.ok(prCreate.includes('done-check の出力の「点検した head」'));
    assert.ok(prCreate.includes('1つでも満たさなければ印を書かない'));
    assert.ok(prCreate.includes('git rev-list --no-merges <点検した head>..<push 済みの head> ^origin/<base>'));
    assert.ok(doneCheck.includes('- 点検した head: 手順 8 のコミットを終えた後の `git rev-parse HEAD` の完全な SHA'));
  });

  test('作成モードのどの経路でも本文の末尾に書く', () => {
    assert.ok(prCreate.includes('本文の末尾に、下の「done-check の印」を書く。'));
    assert.ok(prCreate.includes('Step 3 の「done-check の印」をその後に書く'), 'ドラフトで先に作ったときの書き込み');
  });

  test('印を書くのは pr-create だけ', () => {
    assert.ok(prCreate.includes('印を書くのはこのスキルだけで、`done-check` と `pr-feedback` は書かない'));
    assert.ok(prFeedback.includes('done-check の印は書き足しも書き換えもしない'));
  });
});

describe('本文を書き換えても印を残す', () => {
  test('pr-create の更新モード', () => {
    assert.ok(prCreate.includes(`done-check の印 ${MARK_ANY} も、あれば一字も変えずに残し、無ければ足さない`));
  });

  test('pr-feedback', () => {
    assert.ok(
      prFeedback.includes(
        `目印の \`<!-- pr-create:draft-first -->\` と done-check の印 ${MARK_ANY} を一字も変えずに残す`,
      ),
    );
  });
});

describe('直しの後に AI レビューを1回回す', () => {
  test('pr-feedback は直しのレビューを回していなければラベルを付ける', () => {
    assert.ok(prFeedback.includes('#### 直しのレビューを1回回す'));
    assert.ok(
      prFeedback.includes('gh api -X POST "repos/{owner}/{repo}/issues/{number}/labels" -f "labels[]=ai-review"'),
    );
    assert.ok(
      prFeedback.includes(
        '最初に `success` で終わったものの終わった時刻より後に、`ai-review` のラベルの付与のイベントが無い',
      ),
    );
  });

  test('回した後の直しにはラベルを付けず、報告に並べて人に聞く', () => {
    assert.ok(
      prFeedback.includes(
        '直しのレビューを回した後の直し（このレビューの指摘の直しと、その後の人の指摘の直し）にはラベルを付けない',
      ),
    );
    assert.ok(prFeedback.includes('- AI に見られていない直し: '));
    assert.ok(prFeedback.includes('`ai-review` のラベルを付けて見せるか。選択肢は「付けない（推奨）」「付ける」'));
  });

  test('「差分なし」のコメントは新しい指摘なしとして読み、文は ai-review-scope.ts と同じ', () => {
    const sha = 'a'.repeat(40);
    const quoted = noDiffBody(sha).replace(sha, '<SHA>');
    assert.ok(prFeedback.includes(`「${quoted}」の決まった文だけなら、その実行は新しい指摘なしとして数え`), quoted);
  });

  test('docs/development.md の開発の流れと CI に新しい流れがある', () => {
    assert.ok(development.includes('AI レビューの指摘を直したら、`pr-feedback` が `ai-review` のラベルを1回付け'));
    assert.ok(development.includes('AI レビューの指摘の直しを push したら、`pr-feedback` がラベルを1回付け'));
    assert.ok(development.includes('PR の本文の末尾に印 `<!-- done-check:<SHA> -->` として書く'));
  });
});
