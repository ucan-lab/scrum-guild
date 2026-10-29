import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { load } from 'js-yaml';

// .github/workflows/ai-review.yml の --allowedTools を読む（docs/development.md の「CI」の ai-review）。
// 許可は前方一致なので、gh pr view を許すと --comments で pr-context で落としたコメントを読め、
// gh api を許すと任意の API と外部の URL を叩ける。Bash(gh:*) や Bash(bash:*) のような広い許可からも同じことができるので、
// 一部を絞り込んで見ずに、一覧を丸ごと固定する。許可を足すときは、この一覧も直す
type Step = { uses?: string; with?: Record<string, string> };

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

function allowedTools(): string[] {
  const match = /--allowedTools "([^"]*)"/.exec(claudeArgs());
  assert.ok(match, '--allowedTools が無い');
  return match[1]!.split(',');
}

describe('ai-review の Claude に許す道具', () => {
  test('決まった道具だけを許し、gh pr view、gh pr diff、gh api を許さない', () => {
    assert.deepEqual(allowedTools(), [
      'Task',
      'Agent',
      'mcp__github_inline_comment__create_inline_comment',
      'Bash(gh pr comment ${{ github.event.pull_request.number }} --body:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git rev-parse:*)',
      'Bash(ls:*)',
      'Bash(echo:*)',
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
    // claude_args は1行に1つの引数を書く。値の中の --body を拾わないよう、行の頭だけを見る
    const lines = claudeArgs()
      .split('\n')
      .filter((line) => line.trim() !== '');
    assert.deepEqual(
      lines.map((line) => line.trim().split(/\s/)[0]),
      ['--model', '--add-dir', '--allowedTools'],
    );
  });
});
