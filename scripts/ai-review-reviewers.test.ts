import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

// 静的に import すると型の無いフックのファイルまで pnpm check の型検査に入り、式の import() は lint が断る。
// 子の node に読ませて JSON で受け取る
const rulesUrl = new URL('../.claude/hooks/review-budget-rules.mjs', import.meta.url).href;
const REVIEW_AGENTS = JSON.parse(
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'const m = await import(process.argv[1]); console.log(JSON.stringify(m.REVIEW_AGENTS));',
      rulesUrl,
    ],
    { encoding: 'utf8' },
  ),
) as string[];

// done-check と CI の ai-review は、呼ぶレビューのエージェントを .claude/skills/ai-review/reviewers.md の表だけで決める。
// 表の名前がフックの数える一覧（REVIEW_AGENTS）とずれると、巡の上限が効かないエージェントが出るので突き合わせる
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const reviewers = read('.claude/skills/ai-review/reviewers.md');
const rows = reviewers
  .split('\n')
  .filter((line) => line.startsWith('| `'))
  .map((line) =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim()),
  );

describe('ai-review/reviewers.md の表', () => {
  test('エージェントの名前が REVIEW_AGENTS と一致する（重なりも無い）', () => {
    const names = rows.map((cells) => cells[0]!.replace(/^`|`$/g, ''));
    assert.deepEqual([...names].sort(), [...REVIEW_AGENTS].sort());
  });

  test('列は「手元」「CI（全体）」「CI（起点から）」で、値は「呼ぶ」か「呼ばない」', () => {
    assert.match(reviewers, /^\| エージェント \| 呼ぶとき \| 手元（done-check） \| CI（全体） \| CI（起点から） \|$/m);
    for (const cells of rows) {
      assert.equal(cells.length, 5, cells.join(' | '));
      for (const value of cells.slice(2)) assert.ok(['呼ぶ', '呼ばない'].includes(value), cells.join(' | '));
    }
  });

  test('falsification-qa は CI では起点からの差分のときだけ呼ぶ', () => {
    const row = rows.find((cells) => cells[0] === '`falsification-qa`');
    assert.deepEqual(row?.slice(2), ['呼ぶ', '呼ばない', '呼ぶ']);
  });

  test('done-check と ai-review のスキルが表を指している', () => {
    for (const skill of ['.claude/skills/done-check/SKILL.md', '.claude/skills/ai-review/SKILL.md']) {
      assert.ok(read(skill).includes('.claude/skills/ai-review/reviewers.md'), skill);
    }
  });
});
