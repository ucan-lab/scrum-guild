import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { load } from 'js-yaml';

// .github/workflows/ai-review.yml の --allowedTools を読む（docs/development.md の「CI」の ai-review）。
// 許可は前方一致なので、gh pr view を1つでも許すと --comments で pr-context で落としたコメントを読める
type Step = { uses?: string; with?: Record<string, string> };

const workflow = load(readFileSync(new URL('../.github/workflows/ai-review.yml', import.meta.url), 'utf8')) as {
  jobs: { review: { steps: Step[] } };
};

function allowedTools(): string[] {
  const step = workflow.jobs.review.steps.find((s) => s.uses?.startsWith('anthropics/claude-code-action@'));
  assert.ok(step, 'claude-code-action の段が無い');
  const match = /--allowedTools "([^"]*)"/.exec(step.with?.claude_args ?? '');
  assert.ok(match, '--allowedTools が無い');
  return match[1]!.split(',');
}

describe('ai-review の --allowedTools', () => {
  test('gh pr view を許さない', () => {
    assert.deepEqual(
      allowedTools().filter((tool) => tool.startsWith('Bash(gh pr view')),
      [],
    );
  });

  test('gh api を許さない', () => {
    assert.deepEqual(
      allowedTools().filter((tool) => tool.startsWith('Bash(gh api')),
      [],
    );
  });

  test('gh のコマンドは差分を読むものと、この PR に書くものだけ', () => {
    assert.deepEqual(
      allowedTools().filter((tool) => tool.startsWith('Bash(gh ')),
      ['Bash(gh pr comment ${{ github.event.pull_request.number }} --body:*)', 'Bash(gh pr diff:*)'],
    );
  });
});
