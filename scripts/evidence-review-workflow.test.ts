import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { load } from 'js-yaml';

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  'continue-on-error'?: boolean;
};
const source = readFileSync(new URL('../.github/workflows/evidence-review.yml', import.meta.url), 'utf8');
const workflow = load(source) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      if: string;
      concurrency: { group: string; 'cancel-in-progress': boolean };
      permissions: Record<string, string>;
      outputs: Record<string, string>;
      steps: Step[];
    }
  >;
};
const job = workflow.jobs.decide;
const steps = job.steps;
const named = (name: string) => {
  const step = steps.find((s) => s.name === name);
  assert.ok(step, `${name} の段が無い`);
  return step;
};
const action = (name: string) => {
  const found = steps.filter((s) => s.uses?.startsWith(`${name}@`));
  assert.equal(found.length, 1);
  return found[0];
};

describe('evidence-review の動く条件と境界', () => {
  test('ci の完了、レビュー可能への変更、ai-review のラベルで decide だけが動く', () => {
    assert.deepEqual(workflow.on, {
      workflow_run: { workflows: ['ci'], types: ['completed'] },
      pull_request: { types: ['ready_for_review', 'labeled'] },
    });
    assert.deepEqual(Object.keys(workflow.jobs), ['decide']);
    assert.equal(job.if, "github.event.action != 'labeled' || github.event.label.name == 'ai-review'");
  });

  test('両イベントで同じ PR の group を使い、進行中の処理を取り消さない', () => {
    // head のリポジトリとブランチの組は PR と1対1。fork の同名のブランチと同じ列に並べない
    assert.equal(
      job.concurrency.group,
      'evidence-review-${{ github.event.pull_request.head.repo.full_name || github.event.workflow_run.head_repository.full_name }}-${{ github.event.pull_request.head.ref || github.event.workflow_run.head_branch }}',
    );
    assert.equal(job.concurrency['cancel-in-progress'], false);
  });

  // workflow_run は書き込みのトークンも持ちうるので、許可する一覧を丸ごと固定する
  test('権限は読み取りだけで、ファイルのどこにも秘密情報の参照を置かない', () => {
    assert.deepEqual(workflow.permissions, {});
    assert.deepEqual(job.permissions, { contents: 'read', 'pull-requests': 'read', actions: 'read' });
    assert.ok(!source.includes('secrets.'));
    assert.ok(!source.includes('anthropics/'));
    assert.ok(!source.includes('pnpm install'));
    assert.deepEqual(job.outputs, {
      run: "${{ steps.prepare.outputs.run || 'false' }}",
      pr_number: '${{ steps.pr.outputs.pr_number }}',
    });
  });

  test('main だけを認証を残さず checkout し、固定の Node を使う', () => {
    assert.deepEqual(action('actions/checkout').with, { ref: 'main', 'persist-credentials': false, 'fetch-depth': 0 });
    assert.deepEqual(action('actions/setup-node').with, { 'node-version-file': '.node-version' });
    assert.deepEqual(
      steps.filter((s) => s.uses).map((s) => s.uses),
      [
        'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1',
        'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333',
        'actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9',
      ],
    );
  });

  test('ci のシャードだけを指定した実行から落とし、run=true の材料だけを1日残す', () => {
    const download = action('actions/download-artifact');
    assert.equal(download.if, "steps.gate.outputs.run == 'true'");
    assert.deepEqual(download.with, {
      pattern: 'e2e-[0-9]*',
      'run-id': '${{ steps.ci.outputs.ci_run_id }}',
      'github-token': '${{ github.token }}',
      path: '${{ runner.temp }}/e2e',
    });
    const upload = action('actions/upload-artifact');
    assert.equal(upload.if, "steps.prepare.outputs.run == 'true'");
    assert.deepEqual(upload.with, {
      name: 'evidence-ctx',
      path: '${{ runner.temp }}/evidence-ctx/',
      'retention-days': 1,
      overwrite: true,
    });
  });

  // 前の段が空なら後ろの段は動かさない。段の条件を1つずつ固定し、外れても失敗にする
  test('各段は前の段の出力が揃ったときだけ動く', () => {
    const hasPr = "steps.pr.outputs.pr_number != ''";
    const hasCi = "steps.ci.outputs.ci_run_id != ''";
    const gated = "steps.gate.outputs.run == 'true'";
    const prepared = "steps.prepare.outputs.run == 'true'";
    const conditions: Record<string, string | undefined> = {
      'PR の番号を決める': undefined,
      'PR と ci の実行を取る': hasPr,
      '比べる ci の実行を決める': hasPr,
      'ci のジョブと既存のコメントを取る': hasCi,
      画像を比べる条件を確かめる: hasCi,
      変更前後の画像を並べる: gated,
      'PR の本文とコメントを取る': prepared,
      'PR の本文とコメントを整える': prepared,
      差分を書き出す: prepared,
    };
    for (const [name, expected] of Object.entries(conditions)) assert.equal(named(name).if, expected, name);
    assert.equal(action('actions/download-artifact').if, gated);
    assert.equal(action('actions/upload-artifact').if, prepared);
  });
});

describe('evidence-review の材料', () => {
  test('API の取得と通信しない Node の判定を分け、全ページを保存する', () => {
    const candidate = named('PR の候補を取る');
    assert.ok(candidate.run?.includes('gh api --paginate --slurp "repos/$REPO/commits/$HEAD_SHA/pulls"'));
    assert.ok(
      named('PR と ci の実行を取る').run?.includes(
        'actions/workflows/ci.yml/runs?head_sha=$HEAD_SHA&event=pull_request',
      ),
    );
    const jobs = named('ci のジョブと既存のコメントを取る');
    assert.ok(jobs.run?.includes('gh api --paginate --slurp "repos/$REPO/actions/runs/$CI_RUN_ID/jobs"'));
    assert.ok(jobs.run?.includes('gh api --paginate --slurp "repos/$REPO/issues/$PR_NUMBER/comments"'));
    for (const step of steps.filter((s) => s.run?.includes('gh api'))) {
      assert.equal(step.env?.GH_TOKEN, '${{ github.token }}');
      assert.ok(!step.run?.includes('node '));
    }
    assert.equal(
      named('画像を比べる条件を確かめる').run,
      'node scripts/evidence-review-decide.ts decide "$RUNNER_TEMP/evidence-raw"',
    );
    assert.equal(
      named('画像を比べる条件を確かめる').env?.EVIDENCE_MAIN_PUBLIC_URL,
      '${{ vars.EVIDENCE_MAIN_PUBLIC_URL }}',
    );
  });

  test('PR の本文とコメントは ai-review と同じ段で絞り、元の JSON を消す', () => {
    const ai = load(readFileSync(new URL('../.github/workflows/ai-review.yml', import.meta.url), 'utf8')) as {
      jobs: { review: { steps: Step[] } };
    };
    for (const name of ['PR の本文とコメントを取る', 'PR の本文とコメントを整える']) {
      const step = named(name);
      assert.equal(step.run, ai.jobs.review.steps.find((s) => s.name === name)?.run);
      assert.equal(step.if, "steps.prepare.outputs.run == 'true'");
      assert.equal(step['continue-on-error'], true);
      assert.equal(step.env?.RAW_DIR, '${{ runner.temp }}/pr-raw');
    }
    assert.equal(named('PR の本文とコメントを整える').env?.CONTEXT_DIR, '${{ runner.temp }}/evidence-ctx');
    assert.equal(named('PR の本文とコメントを取る').env?.PR_NUMBER, '${{ steps.pr.outputs.pr_number }}');
  });

  test('head は fetch だけし、画像と同じ SHA の差分を日本語のパスを保って書く', () => {
    const step = named('差分を書き出す');
    assert.equal(step['continue-on-error'], undefined);
    assert.equal(step.env?.BASE_SHA, '${{ steps.gate.outputs.base_sha }}');
    assert.equal(step.env?.HEAD_SHA, '${{ steps.gate.outputs.head_sha }}');
    assert.equal(step.env?.CONTEXT_DIR, '${{ runner.temp }}/evidence-ctx');
    assert.ok(step.run?.includes('git fetch origin "pull/$PR_NUMBER/head"'));
    assert.ok(step.run?.includes('git diff "$BASE_SHA...$HEAD_SHA" > "$CONTEXT_DIR/diff.patch"'));
    assert.ok(
      step.run?.includes(
        'git -c core.quotePath=false diff --name-status "$BASE_SHA...$HEAD_SHA" > "$CONTEXT_DIR/files.txt"',
      ),
    );
    assert.ok(!steps.some((s) => /git (checkout|switch|reset)/.test(s.run ?? '')));
    const prepare = named('変更前後の画像を並べる');
    assert.equal(prepare.env?.BASE_SHA, step.env?.BASE_SHA);
    assert.equal(prepare.env?.HEAD_SHA, step.env?.HEAD_SHA);
  });
});
