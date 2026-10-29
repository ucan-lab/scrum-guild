import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { load } from 'js-yaml';

// .github/workflows/ai-review.yml の --allowedTools と --disallowedTools を読む（docs/development.md の「CI」の ai-review）。
// Bash の許可は前方一致で後ろの引数を縛らず、gh pr comment -R で外へ送る、git diff --output= でランナーのファイルに書く、
// といった抜け道が残る。Bash は一切許さず、一部を絞り込んで見ずに、一覧を丸ごと固定する。許可を足すときは、この一覧も直す
type Step = {
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  'continue-on-error'?: boolean;
};

const workflow = load(readFileSync(new URL('../.github/workflows/ai-review.yml', import.meta.url), 'utf8')) as {
  jobs: { review: { steps: Step[] } };
};

function actionStep(): Step {
  const steps = workflow.jobs.review.steps.filter((s) => s.uses?.startsWith('anthropics/claude-code-action@'));
  assert.equal(steps.length, 1, 'claude-code-action の段がちょうど1つでない');
  return steps[0]!;
}

function claudeArgs(): string {
  return actionStep().with?.claude_args ?? '';
}

function toolList(flag: '--allowedTools' | '--disallowedTools'): string[] {
  const match = new RegExp(`${flag} "([^"]*)"`).exec(claudeArgs());
  assert.ok(match, `${flag} が無い`);
  return match[1]!.split(',');
}

describe('ai-review の Claude に許す道具', () => {
  test('決まった道具だけを許し、書けるのはまとめの1ファイルだけ', () => {
    assert.deepEqual(toolList('--allowedTools'), [
      'Task',
      'Agent',
      'mcp__github_inline_comment__create_inline_comment',
      'Edit(/${{ runner.temp }}/pr-out/summary.md)',
    ]);
  });

  test('Bash を1つも許さない', () => {
    assert.ok(!toolList('--allowedTools').some((tool) => tool === 'Bash' || tool.startsWith('Bash(')));
  });

  // base の .claude/settings.json の許可は --allowedTools の外から効く。断る側は許可より勝つので、ここで固定する
  test('Bash、github の MCP、チェックアウトの .git の読み取りを断る', () => {
    assert.deepEqual(toolList('--disallowedTools'), [
      'Bash',
      'mcp__github__*',
      'Read(/${{ github.workspace }}/.git/**)',
    ]);
  });

  // 上の一覧の外でも、action の入力（allowed_tools、settings など）や claude_args の別の引数
  // （--permission-mode、--mcp-config、--settings など）で許可を広げられる。mcp__github__ を1つでも許すと、
  // action が github の MCP サーバーを入れ、base の .claude/settings.json の許可で絞る前のコメントを読める。
  // 禁止の一覧では足し漏れるので、使ってよい名前を丸ごと固定する
  test('action の入力と claude_args の引数は、決まった名前だけ', () => {
    assert.deepEqual(Object.keys(actionStep().with ?? {}).sort(), [
      'classify_inline_comments',
      'claude_args',
      'claude_code_oauth_token',
      'github_token',
      'prompt',
    ]);
    // claude_args は1行に1つの引数を書く。値の中の文字列を拾わないよう、行の頭だけを見る
    const lines = claudeArgs()
      .split('\n')
      .filter((line) => line.trim() !== '');
    assert.deepEqual(
      lines.map((line) => line.trim().split(/\s/)[0]),
      ['--model', '--add-dir', '--add-dir', '--allowedTools', '--disallowedTools'],
    );
  });
});

describe('ai-review の前後の段', () => {
  const steps = workflow.jobs.review.steps;
  const actionIndex = steps.indexOf(actionStep());
  const named = (name: string): Step => {
    const step = steps.find((s) => s.name === name);
    assert.ok(step, `${name} の段が無い`);
    return step;
  };

  // 差分の無いレビューは意味が無いので、差分の段は continue-on-error を付けず、落ちたらジョブを落とす
  test('差分は action の前の段が書き出し、落ちたらジョブを落とす', () => {
    const step = named('差分を書き出す');
    assert.ok(steps.indexOf(step) < actionIndex);
    assert.equal(step['continue-on-error'], undefined);
    assert.match(step.run ?? '', /> "\$CONTEXT_DIR\/diff\.patch"/);
    assert.match(step.run ?? '', /--name-status .*> "\$CONTEXT_DIR\/files\.txt"/);
  });

  // 番号を Claude に選ばせず、イベントの PR の番号に固定する。action が落ちても、書かずに終わった旨を付ける
  test('まとめは action の後の段が、この PR の番号に固定して付ける', () => {
    const step = named('まとめを PR に付ける');
    assert.ok(steps.indexOf(step) > actionIndex);
    assert.equal(step.if, '${{ !cancelled() }}');
    assert.equal(step.env?.PR_NUMBER, '${{ github.event.pull_request.number }}');
    assert.equal(step.env?.REPO, '${{ github.repository }}');
    assert.match(step.run ?? '', /gh pr comment "\$PR_NUMBER" -R "\$REPO" --body-file "\$BODY_FILE"/);
  });
});
