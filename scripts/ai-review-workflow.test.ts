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

function claudeArgs(): string {
  const step = workflow.jobs.review.steps.find((s) => s.uses?.startsWith('anthropics/claude-code-action@'));
  assert.ok(step, 'claude-code-action の段が無い');
  return step.with?.claude_args ?? '';
}

function allowedTools(): string[] {
  const match = /--allowedTools "([^"]*)"/.exec(claudeArgs());
  assert.ok(match, '--allowedTools が無い');
  return match[1]!.split(',');
}

describe('ai-review の --allowedTools', () => {
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

  // 上の一覧の外で許可を広げる書き方。mcp__github__ を1つでも許すと、action が github の MCP サーバーを入れ、
  // base の .claude/settings.json の許可で絞る前のコメントを読める
  test('許可を広げるほかの引数を渡さない', () => {
    const args = claudeArgs();
    assert.equal(args.match(/--allowedTools/g)?.length, 1);
    for (const flag of ['--allowed-tools', '--permission-mode', '--dangerously-skip-permissions', 'mcp__github__']) {
      assert.ok(!args.includes(flag), `${flag} を渡している`);
    }
  });
});
