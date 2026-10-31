import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { load } from 'js-yaml';

// .github/workflows/ai-review.yml の --allowedTools と --disallowedTools を読む（docs/development.md の「CI」の ai-review）。
// Bash の許可は前方一致で後ろの引数を縛らず、gh pr comment -R で外へ送る、git diff --output= でランナーのファイルに書く、
// といった抜け道が残る。Bash は一切許さず、一部を絞り込んで見ずに、一覧を丸ごと固定する。許可を足すときは、この一覧も直す
type Step = {
  id?: string;
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
  test('action の入力は、決まった名前だけ', () => {
    assert.deepEqual(Object.keys(actionStep().with ?? {}).sort(), [
      'classify_inline_comments',
      'claude_args',
      'claude_code_oauth_token',
      'github_token',
      'prompt',
    ]);
  });

  // 行の頭の名前だけを見ると、同じ行の後ろに足した引数（2つ目の --allowedTools、--permission-mode）と、
  // --add-dir の値を広げる書き換えを見逃す。行を丸ごと固定する。
  // --tools は組み込みの道具そのものを絞る。--allowedTools に無くても確認なしに走る道具（RemoteTrigger、EnterWorktree、
  // CronCreate など）があり、断りの一覧では足し漏れるため
  test('claude_args は決まった行だけ', () => {
    const lines = claudeArgs()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    assert.deepEqual(lines, [
      '--model sonnet',
      '--add-dir "${{ runner.temp }}/pr-context"',
      '--add-dir "${{ runner.temp }}/pr-out"',
      '--tools "Read,Grep,Glob,Edit,Write,Agent"',
      '--allowedTools "Task,Agent,mcp__github_inline_comment__create_inline_comment,Edit(/${{ runner.temp }}/pr-out/summary.md)"',
      '--disallowedTools "Bash,mcp__github__*,Read(/${{ github.workspace }}/.git/**)"',
    ]);
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
  // 範囲の向きが逆だと、追加と削除が入れ替わった差分をレビューする。
  // files.txt は Claude がパスとして Read に渡すので、日本語のパスを \343... にクォートさせない
  test('差分は action の前の段が base から head の向きで書き出し、落ちたらジョブを落とす', () => {
    const step = named('差分を書き出す');
    assert.ok(steps.indexOf(step) < actionIndex);
    assert.equal(step['continue-on-error'], undefined);
    assert.equal(step.id, 'diff');
    assert.equal(step.env?.SCOPE_OUTCOME, '${{ steps.scope.outcome }}');
    assert.equal(step.env?.SCOPE_MODE, '${{ steps.scope.outputs.mode }}');
    assert.equal(step.env?.SCOPE_START, '${{ steps.scope.outputs.start }}');
    assert.equal(step.env?.BASE_SHA, '${{ github.event.pull_request.base.sha }}');
    assert.equal(step.env?.HEAD_SHA, '${{ github.event.pull_request.head.sha }}');
    const run = step.run ?? '';
    assert.ok(run.includes('git diff "$BASE_SHA...$HEAD_SHA" > "$CONTEXT_DIR/diff.patch"'), run);
    assert.ok(
      run.includes('git -c core.quotePath=false diff --name-status "$BASE_SHA...$HEAD_SHA" > "$CONTEXT_DIR/files.txt"'),
      run,
    );
  });

  test('取る、起点、整える、差分、差分なし、action、まとめ、ラベルの順に並ぶ', () => {
    const names = steps
      .map((step) => step.name)
      .filter(
        (name): name is string =>
          name !== undefined &&
          (name.includes('PR の本文') ||
            [
              '起点を決める',
              '差分を書き出す',
              '差分が無い旨を PR に付ける',
              'まとめを PR に付ける',
              'ai-review のラベルを外す',
            ].includes(name)),
      );
    assert.deepEqual(names, [
      'PR の本文とコメントを取る',
      '起点を決める',
      'PR の本文とコメントを整える',
      '差分を書き出す',
      '差分が無い旨を PR に付ける',
      'まとめを PR に付ける',
      'ai-review のラベルを外す',
    ]);
    assert.equal(named('起点を決める').id, 'scope');
    assert.equal(named('起点を決める')['continue-on-error'], true);
    assert.equal(named('差分が無い旨を PR に付ける').if, "steps.diff.outputs.mode == 'none'");
    assert.equal(actionStep().id, 'claude');
    assert.equal(actionStep().if, "steps.diff.outputs.mode != 'none'");
  });

  // 番号を Claude に選ばせず、イベントの PR の番号に固定する。action が落ちても、書かずに終わった旨を付ける
  test('まとめは action の後の段が、この PR の番号に固定して付ける', () => {
    const step = named('まとめを PR に付ける');
    assert.ok(steps.indexOf(step) > actionIndex);
    assert.equal(step.if, "${{ !cancelled() && steps.diff.outputs.mode != 'none' }}");
    assert.equal(step.env?.PR_NUMBER, '${{ github.event.pull_request.number }}');
    assert.equal(step.env?.REPO, '${{ github.repository }}');
    assert.equal(
      step.env?.MARK_SHA,
      "${{ steps.claude.outcome == 'success' && github.event.pull_request.head.sha || '' }}",
    );
    const run = step.run ?? '';
    const build = run.indexOf('node scripts/ai-review-summary.ts "$OUT_FILE" "$BODY_FILE"');
    const post = run.indexOf('gh pr comment "$PR_NUMBER" -R "$REPO" --body-file "$BODY_FILE"');
    assert.ok(build >= 0 && post > build, run);
  });

  // 1つでもずれると、Claude の Write が許可の外で断られるか、後の段が別のファイルを探し、毎回「書かずに終わった」になる
  test('Claude に渡す OUT_FILE、書いてよいファイル、後の段が読むファイルがそろっている', () => {
    const outFile = '${{ runner.temp }}/pr-out/summary.md';
    assert.ok(actionStep().with?.prompt?.includes(` OUT_FILE: ${outFile}`));
    assert.ok(toolList('--allowedTools').includes(`Edit(/${outFile})`));
    assert.equal(named('まとめを PR に付ける').env?.OUT_FILE, outFile);
  });

  // EVENT_ACTION が渡らないと labeled でも none になり、人が回したのに全体を見ない。
  // 差分なしの本文のファイルが起点の段とずれると、gh pr comment が無いファイルを読んで落ちる
  test('起点の段は pr-raw を消す前にスクリプトを走らせ、差分なしの段と本文のファイルを共有する', () => {
    const scope = named('起点を決める');
    assert.equal(scope.run, 'node scripts/ai-review-scope.ts');
    assert.deepEqual(scope.env, {
      RAW_DIR: '${{ runner.temp }}/pr-raw',
      CONTEXT_DIR: '${{ runner.temp }}/pr-context',
      BASE_SHA: '${{ github.event.pull_request.base.sha }}',
      HEAD_SHA: '${{ github.event.pull_request.head.sha }}',
      EVENT_ACTION: '${{ github.event.action }}',
      NO_DIFF_BODY_FILE: '${{ runner.temp }}/pr-no-diff-body.md',
    });
    assert.equal(named('PR の本文とコメントを整える').env?.RAW_DIR, scope.env?.RAW_DIR);
    const noDiff = named('差分が無い旨を PR に付ける');
    assert.equal(noDiff.env?.NO_DIFF_BODY_FILE, scope.env?.NO_DIFF_BODY_FILE);
    assert.equal(noDiff.env?.PR_NUMBER, '${{ github.event.pull_request.number }}');
    assert.equal(noDiff.run, 'gh pr comment "$PR_NUMBER" -R "$REPO" --body-file "$NO_DIFF_BODY_FILE"');
  });
});

// 「差分を書き出す」段の run を、使い捨てのリポジトリで bash に走らせる。
// 起点の段が落ちたら全体に倒すのが Issue の要なので、文字列の有無でなく振る舞いで固定する
describe('差分を書き出す段の run', () => {
  const run = workflow.jobs.review.steps.find((s) => s.name === '差分を書き出す')?.run ?? '';
  const git = (dir: string, args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

  function exec(opts: { outcome: string; mode?: string; start?: string; prepare?: (context: string) => void }) {
    const dir = mkdtempSync(join(tmpdir(), 'ai-review-diff-step-'));
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.invalid']);
    git(dir, ['config', 'user.name', 'test']);
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-qm', 'base']);
    const base = git(dir, ['rev-parse', 'HEAD']);
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-qm', 'head']);
    const head = git(dir, ['rev-parse', 'HEAD']);
    const context = join(dir, '.context');
    const output = join(dir, '.output');
    mkdirSync(context);
    writeFileSync(output, '');
    opts.prepare?.(context);
    const result = spawnSync('bash', ['-c', run], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        BASE_SHA: base,
        HEAD_SHA: head,
        CONTEXT_DIR: context,
        OUT_DIR: join(dir, '.out'),
        SCOPE_OUTCOME: opts.outcome,
        SCOPE_MODE: opts.mode ?? '',
        SCOPE_START: opts.start ?? '',
        GITHUB_OUTPUT: output,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const read = (name: string) => readFileSync(join(context, name), 'utf8');
    return { output: readFileSync(output, 'utf8'), read, outDir: existsSync(join(dir, '.out')) };
  }

  const prepared = (context: string) => {
    writeFileSync(join(context, 'diff.patch'), 'SCOPED\n');
    writeFileSync(join(context, 'files.txt'), 'M\tscoped.txt\n');
    writeFileSync(join(context, 'scope.md'), '- 方式: 起点から\n');
  };

  test('起点の段が落ちたら、全体の差分を書いて mode=full を出す', () => {
    const out = exec({ outcome: 'failure', mode: 'none', prepare: prepared });
    assert.equal(out.output, 'mode=full\nstart=\n');
    assert.equal(out.read('files.txt'), 'A\tb.txt\n');
    assert.match(out.read('diff.patch'), /\+b/);
    assert.match(out.read('scope.md'), /全体（起点の判定が落ちたため）/);
    assert.ok(out.outDir);
  });

  test('起点の段が成功しても、書いたファイルが欠けていれば全体に倒す', () => {
    const out = exec({
      outcome: 'success',
      mode: 'since',
      start: 'a'.repeat(40),
      prepare: (context) => writeFileSync(join(context, 'files.txt'), 'M\tscoped.txt\n'),
    });
    assert.equal(out.output, 'mode=full\nstart=\n');
    assert.equal(out.read('files.txt'), 'A\tb.txt\n');
  });

  for (const mode of ['since', 'none', 'full']) {
    test(`起点の段が成功して3つのファイルがそろえば、書いたものを使い mode=${mode} をそのまま出す`, () => {
      const out = exec({ outcome: 'success', mode, start: 'a'.repeat(40), prepare: prepared });
      assert.equal(out.output, `mode=${mode}\nstart=${'a'.repeat(40)}\n`);
      assert.equal(out.read('diff.patch'), 'SCOPED\n');
      assert.equal(out.read('files.txt'), 'M\tscoped.txt\n');
    });
  }
});
