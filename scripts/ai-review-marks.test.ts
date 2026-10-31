import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { extractMarkers, noDiffBody } from './ai-review-scope.ts';
import { INCOMPLETE_LINE, summaryBody } from './ai-review-summary.ts';

// CI の ai-review は、PR 本文の done-check の印と前のまとめの印から後の差分だけを見る（scripts/ai-review-scope.ts）。
// 印を書く、残す、直しの後にラベルを1回付ける決まりはスキルの文言にしか無い。
// 判定の鍵になる語とコマンドの断片だけを固定し、スキルが書く形と CI の読む形がずれたら落とす
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const prCreate = read('.claude/skills/pr-create/SKILL.md');
const prFeedback = read('.claude/skills/pr-feedback/SKILL.md');
const doneCheck = read('.claude/skills/done-check/SKILL.md');
const stack = read('.claude/skills/pr-create/stack.md');
const development = read('docs/development.md');

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const bot = { login: 'github-actions[bot]', type: 'Bot' };

const has = (text: string, needle: string, what: string) =>
  assert.ok(text.includes(needle), `${what}: 「${needle}」が無い`);

describe('done-check の印を書く', () => {
  test('pr-create が書くひな形に SHA を入れると、ai-review-scope.ts が拾う', () => {
    const template = /`(<!-- done-check:<完全な SHA> -->)`/.exec(prCreate)?.[1];
    assert.ok(template, 'pr-create に印のひな形が無い');
    const body = `本文\n\n${template.replace('<完全な SHA>', SHA)}\n`;
    assert.deepEqual(extractMarkers(body, []), [{ sha: SHA, source: 'done-check' }]);
  });

  test('点検した head はレビューに渡した head で、push 済みの head の祖先なら書く', () => {
    has(
      doneCheck,
      '- 点検した head: 手順 6 でレビューのエージェントに渡したときの `git rev-parse HEAD`',
      'done-check の出力',
    );
    has(doneCheck, '手順 7 の直しのコミットは含めない', 'done-check の出力');
    has(doneCheck, '呼ぶ直前に `git rev-parse HEAD` の完全な SHA を控え', 'done-check の手順 6');
    has(doneCheck, '`点検した head: 無し — <理由>`', 'done-check の出力');
    has(prCreate, 'done-check の出力の「点検した head」', 'pr-create');
    has(prCreate, '1つでも満たさなければ印を書かない', 'pr-create');
    has(prCreate, '`git merge-base --is-ancestor <点検した head> <push 済みの head>`', 'pr-create');
    has(prCreate, '点検した head が `無し` のときは書かない', 'pr-create');
  });

  test('作成モードのどの経路でも本文の末尾に書き、書くのは pr-create だけ', () => {
    has(prCreate, '本文の末尾に、下の「done-check の印」を書く。', 'pr-create の本文');
    has(prCreate, 'Step 3 の「done-check の印」をその後に書く', 'pr-create のドラフトへの書き込み');
    has(stack, 'base が `main` の層の本文には、目印の後に SKILL.md の Step 3 の「done-check の印」を書く', 'stack.md');
    has(prCreate, '印を書くのはこのスキルだけで、`done-check` と `pr-feedback` は書かない', 'pr-create');
  });
});

describe('本文を書き換えても印を残す', () => {
  test('pr-create の更新モードは、あれば残し、無ければ足さない', () => {
    has(
      prCreate,
      'done-check の印 `<!-- done-check:<SHA> -->` も、あれば一字も変えずに残し、無ければ足さない',
      'pr-create',
    );
  });

  test('pr-feedback は書き換える前にあった印を残し、書き足さない', () => {
    has(prFeedback, 'done-check の印 `<!-- done-check:<SHA> -->` を一字も変えずに残す', 'pr-feedback');
    has(prFeedback, 'done-check の印は書き足しも書き換えもしない', 'pr-feedback');
    has(prFeedback, '書き換える前の本文にあった印が一字違わず残っていることを確かめる', 'pr-feedback');
  });
});

describe('直しの後に AI レビューを1回回す', () => {
  // pr-feedback が jq の capture に書いた正規表現を JS の正規表現として読み、ai-review-summary.ts が付ける形と突き合わせる。
  // jq（Oniguruma）そのものは動かさないので、確かめるのは形が合っていることまで
  const capture = /capture\("(\^<!-- ai-review:\(\?<sha>\[0-9a-f\]\{40\}\) -->)"\)/.exec(prFeedback)?.[1];

  test('見た回数と見た先を、まとめの先頭の印から取る', () => {
    assert.ok(capture, 'pr-feedback に印を拾う jq の capture が無い');
    has(prFeedback, 'select(.user.login == "github-actions[bot]" and .user.type == "Bot")', 'pr-feedback の jq');
    has(prFeedback, '{created_at, sha: (.body | capture(', 'pr-feedback の jq が印のコメントの時刻を出す');
    const pattern = new RegExp(capture);
    assert.equal(pattern.exec(summaryBody('まとめ', SHA))?.groups?.sha, SHA, 'まとめの印を拾えない');
    assert.equal(pattern.exec(noDiffBody(SHA)), null, '差分なしのコメントを見たものに数えた');
    assert.equal(
      pattern.exec(summaryBody(`${INCOMPLETE_LINE}。エージェントの報告が返らなかった`, SHA)),
      null,
      '見終えていないまとめを見たものに数えた',
    );
    assert.equal(pattern.exec(`まとめ\n<!-- ai-review:${OTHER_SHA} -->`), null, '先頭でない印を拾った');
    // ai-review-scope.ts も同じコメントから同じ SHA を拾う
    assert.deepEqual(extractMarkers('', [[{ user: bot, body: summaryBody('まとめ', SHA) }]]), [
      { sha: SHA, source: 'ai-review' },
    ]);
  });

  test('ラベルを付けるのは見た回数が 1 で、bot の指摘の直しがあり、PR の head が手元と同じとき', () => {
    has(prFeedback, '##### AI に見られた範囲', 'pr-feedback');
    has(prFeedback, '- 見た回数: 出力の SHA の重複を除いた数', 'pr-feedback');
    has(
      prFeedback,
      '`git rev-list --count <SHA>..HEAD` が最小のもの。並べば ai-review の印を先にする',
      'pr-feedback の見た先',
    );
    has(
      prFeedback,
      '- 見た回数が 1（最初のレビューだけ）。2 以上なら、直しのレビューは回したものとする',
      'pr-feedback',
    );
    has(prFeedback, '実行の履歴とラベルのイベントでは決めない', 'pr-feedback');
    has(
      prFeedback,
      '最後の印のコメントより後に、`ai-review` のラベルの付与のイベントが無い',
      'pr-feedback の付け直しの止め',
    );
    has(
      prFeedback,
      '0（最初のレビューが「差分が無いので見ない」か、印の無いまま終わった）なら',
      'pr-feedback の見た回数 0',
    );
    has(
      prFeedback,
      'select(.event == "labeled" and .label.name == "ai-review") | .created_at',
      'pr-feedback のラベルのイベントの jq',
    );
    has(prFeedback, 'このセッションで push したかでは決めない', 'pr-feedback');
    has(prFeedback, '`git rev-parse <短い SHA>`）の先頭と一致するもの', 'pr-feedback の短い SHA の突き合わせ');
    has(prFeedback, '手元の `git rev-parse HEAD` と一致する', 'pr-feedback');
    has(prFeedback, '30 秒おきに 5 回まで取り直し', 'pr-feedback の head の待ち');
    has(prFeedback, '先に `git fetch origin` で `origin/<base>` を最新にしてから', 'pr-feedback の fetch');
    has(prFeedback, '"$(git merge-base origin/<base> HEAD)"', 'pr-feedback の main 上の判定');
    has(prFeedback, 'gh api -X DELETE "repos/{owner}/{repo}/issues/{number}/labels/ai-review"', 'pr-feedback');
    has(
      prFeedback,
      'gh api -X POST "repos/{owner}/{repo}/issues/{number}/labels" -f "labels[]=ai-review"',
      'pr-feedback',
    );
  });

  test('ほかの直しにはラベルを付けず、短い SHA を報告に並べて人に聞く', () => {
    has(prFeedback, '`git rev-list --no-merges --abbrev-commit <見た先>..HEAD ^origin/<base>`', 'pr-feedback');
    has(prFeedback, '見た回数が 2 以上になった後の直し', 'pr-feedback');
    has(prFeedback, 'ラベルで回したのに印が増えなかった後の直しにも付けない', 'pr-feedback');
    has(
      prFeedback,
      '- AI に見られていない直し: 手順 4 の「AI に見られた範囲」で決めたコミットの短い SHA',
      'pr-feedback の手順 6',
    );
    has(
      prFeedback,
      '`ai-review` のラベルを付けて見せるか。選択肢は「付けない（推奨）」「付ける」',
      'pr-feedback の手順 7',
    );
  });

  test('「差分なし」のコメントは新しい指摘なしとして読み、文は ai-review-scope.ts と同じ', () => {
    const quoted = noDiffBody(SHA).replace(SHA, '<SHA>');
    has(prFeedback, `「${quoted}」の決まった文だけなら、その実行は新しい指摘なしとして数え`, 'pr-feedback');
  });

  test('docs/development.md の開発の流れと CI に新しい流れがある', () => {
    has(development, 'PR の本文の末尾に印 `<!-- done-check:<SHA> -->` として書く', '開発の流れ');
    has(development, 'AI レビューの指摘を直したら、`pr-feedback` が `ai-review` のラベルを1回付け', '開発の流れ');
    has(development, 'AI レビューの指摘の直しを push したら、`pr-feedback` がラベルを1回付け', 'CI');
    has(development, 'bot のまとめの先頭の ai-review の印の SHA の数（重複を除く）で決め', 'CI');
  });
});
