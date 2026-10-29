import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import {
  comparisonBaseSha,
  decideReview,
  decideScreens,
  EVIDENCE_REVIEW_MARKER,
  resolvePrNumber,
  selectCiRun,
  type ReviewEvent,
  type ReviewPr,
} from './evidence-review-decide.ts';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const pr: ReviewPr = {
  number: 532,
  state: 'open',
  draft: false,
  base: { ref: 'main', sha: base },
  head: { sha: head, repo: { full_name: 'example/project' } },
  user: { type: 'User' },
  author_association: 'OWNER',
};
const ciPath = '.github/workflows/ci.yml';
const ci = {
  id: 100,
  head_sha: head,
  status: 'completed',
  event: 'pull_request',
  path: ciPath,
  head_repository: { full_name: 'example/project' },
};
const event: ReviewEvent = { action: 'ready_for_review', pull_request: pr };
const repositoryId = 4242;
// workflow_run の PR は、base のリポジトリがこのリポジトリのものだけを使う
const sameRepo = { id: repositoryId };
const workflowRun = (pull_requests: NonNullable<ReviewEvent['workflow_run']>['pull_requests'], extra = {}) => ({
  repository: { id: repositoryId },
  workflow_run: { ...ci, head_repository: { full_name: 'example/project' }, pull_requests, ...extra },
});
const input = () => ({
  event,
  repository: 'example/project',
  pr: structuredClone(pr),
  ci: { ...ci },
  jobs: [
    { name: 'e2e (1)', conclusion: 'success' },
    { name: 'e2e (2)', conclusion: 'success' },
    { name: 'evidence', conclusion: 'success' },
  ],
  comments: [],
  mainUrl: 'https://example.test',
});

describe('decideReview', () => {
  test('OWNER と COLLABORATOR の PR は条件を満たせば比較へ進む', () => {
    for (const author_association of ['OWNER', 'COLLABORATOR']) {
      const value = input();
      value.pr.author_association = author_association;
      assert.equal(decideReview(value).run, true);
    }
  });

  test('ドラフト、別の base、fork、Bot、書き込み権限の無い作成者を通さない', () => {
    for (const patch of [
      { draft: true },
      { state: 'closed' },
      { base: { ...pr.base, ref: 'other' } },
      { head: { ...pr.head, repo: { full_name: 'other/project' } } },
      { head: { ...pr.head, repo: null } },
      { user: { type: 'Bot' } },
      ...['MEMBER', 'CONTRIBUTOR', 'FIRST_TIMER', 'NONE'].map((author_association) => ({ author_association })),
    ]) {
      assert.equal(decideReview({ ...input(), pr: { ...pr, ...patch } }).run, false, JSON.stringify(patch));
    }
    assert.equal(decideReview({ ...input(), pr: undefined }).run, false);
  });

  test('ci が無いか未完了、別の head、push の実行なら通さない', () => {
    for (const run of [
      undefined,
      { ...ci, status: 'in_progress' },
      { ...ci, status: 'queued' },
      { ...ci, head_sha: 'c'.repeat(40) },
      { ...ci, event: 'push' },
    ]) {
      assert.equal(decideReview({ ...input(), ci: run }).run, false);
    }
  });

  test('e2e が1つ以上で全て成功し、evidence も成功したときだけ通す', () => {
    for (const conclusion of ['failure', 'cancelled', 'skipped', null]) {
      const value = input();
      assert.equal(decideReview({ ...value, jobs: [...value.jobs, { name: 'e2e (3)', conclusion }] }).run, false);
      assert.equal(
        decideReview({ ...value, jobs: [...value.jobs.slice(0, 2), { name: 'evidence', conclusion }] }).run,
        false,
      );
    }
    assert.equal(decideReview({ ...input(), jobs: [{ name: 'evidence', conclusion: 'success' }] }).run, false);
    assert.equal(decideReview({ ...input(), jobs: input().jobs.slice(0, 2) }).run, false);
    assert.equal(
      decideReview({
        ...input(),
        jobs: [
          ...input().jobs,
          { name: 'e2e-dev (1)', conclusion: 'failure' },
          { name: 'e2e-repeat (1)', conclusion: 'failure' },
        ],
      }).run,
      true,
    );
  });

  test('自動は目印を含む github-actions[bot] のコメントがあれば止まり、ラベルなら再判定する', () => {
    const comments = [{ body: `本文\n${EVIDENCE_REVIEW_MARKER}`, user: { login: 'github-actions[bot]' } }];
    for (const automatic of [event, workflowRun([{ number: pr.number, base: { repo: sameRepo } }])]) {
      assert.equal(decideReview({ ...input(), event: automatic, comments }).run, false);
    }
    assert.equal(
      decideReview({ ...input(), comments, event: { ...event, action: 'labeled', label: { name: 'ai-review' } } }).run,
      true,
    );
    assert.equal(
      decideReview({ ...input(), event: { ...event, action: 'labeled', label: { name: 'other' } } }).run,
      false,
    );
    assert.equal(
      decideReview({ ...input(), comments: [{ body: EVIDENCE_REVIEW_MARKER, user: { login: 'someone' } }] }).run,
      true,
    );
    assert.equal(
      decideReview({ ...input(), comments: [{ body: '<!-- e2e-evidence -->', user: comments[0].user }] }).run,
      true,
    );
  });

  test('workflow_run は main の ci.yml の、このリポジトリの head の実行だけを通す', () => {
    const accepted = workflowRun([{ number: pr.number, base: { repo: sameRepo } }]);
    assert.equal(decideReview({ ...input(), event: accepted }).run, true);
    for (const extra of [
      { path: '.github/workflows/other.yml' },
      { path: undefined },
      { path: `${ciPath}@refs/heads/main` },
      { head_repository: { full_name: 'other/project' } },
      { head_repository: undefined },
    ]) {
      const event = workflowRun([], extra);
      assert.equal(decideReview({ ...input(), event }).run, false, JSON.stringify(extra));
    }
  });

  test('公開 URL が空なら止める', () => {
    for (const mainUrl of ['', '  ']) assert.equal(decideReview({ ...input(), mainUrl }).run, false);
  });
});

describe('PR と ci の選択', () => {
  test('イベントの最初の PR を優先し、無ければ同じ head の開いた PR を使う', () => {
    assert.equal(resolvePrNumber(event, []), pr.number);
    const listed = workflowRun([
      { number: 7, base: { repo: sameRepo } },
      { number: 8, base: { repo: sameRepo } },
    ]);
    assert.equal(resolvePrNumber(listed, [pr]), 7);
    const workflow = workflowRun([]);
    assert.equal(
      resolvePrNumber(workflow, [
        { ...pr, number: 1, state: 'closed' },
        { ...pr, number: 2, head: { ...pr.head, sha: base } },
        pr,
      ]),
      pr.number,
    );
    assert.equal(resolvePrNumber(workflow, []), undefined);
  });

  test('候補は main 向けを優先し、stacked PR の子が先に来ても親でなく main 向けを選ぶ', () => {
    const child = { ...pr, number: 1, base: { ...pr.base, ref: 'parent-branch' } };
    assert.equal(resolvePrNumber(workflowRun([]), [child, pr]), pr.number);
    assert.equal(resolvePrNumber(workflowRun([]), [pr, child]), pr.number);
    // main 向けが無ければ、判定側で断れるよう最初の候補を返す
    assert.equal(resolvePrNumber(workflowRun([]), [child]), child.number);
  });

  test('workflow_run の PR は base のリポジトリがイベントのリポジトリと同じものだけを使う', () => {
    const fork = { id: 1 };
    const candidates = [pr];
    assert.equal(
      resolvePrNumber(workflowRun([{ number: 7, base: { repo: fork } }]), candidates),
      pr.number,
      '別のリポジトリの PR は候補に倒す',
    );
    assert.equal(resolvePrNumber(workflowRun([{ number: 7 }]), candidates), pr.number);
    assert.equal(
      resolvePrNumber(
        workflowRun([
          { number: 7, base: { repo: fork } },
          { number: 8, base: { repo: sameRepo } },
        ]),
        candidates,
      ),
      8,
    );
    const noRepository = { ...workflowRun([{ number: 7, base: { repo: sameRepo } }]), repository: undefined };
    assert.equal(resolvePrNumber(noRepository, candidates), pr.number);
  });

  test('最新の ci が未完了でも、古い成功へ戻さない', () => {
    const newer = { ...ci, id: 101, status: 'in_progress' };
    assert.deepEqual(
      selectCiRun(event, [ci, newer, { ...ci, id: 102, head_sha: base }, { ...ci, id: 103, event: 'push' }]),
      newer,
    );
    assert.equal(selectCiRun(event, []), undefined);
    const workflow = workflowRun([]);
    assert.deepEqual(selectCiRun(workflow, [newer]), workflow.workflow_run);
  });

  test('pull_request で選ぶ ci の実行は ci.yml のものだけ', () => {
    const other = { ...ci, id: 200, path: '.github/workflows/other.yml' };
    const noPath = { ...ci, id: 201, path: undefined };
    assert.deepEqual(selectCiRun(event, [ci, other, noPath]), ci);
    assert.equal(selectCiRun(event, [other, noPath]), undefined);
  });

  // fork の PR の ci も同じ head の SHA で走りうる。別のリポジトリの head で撮った画像を材料にしない
  test('pull_request で選ぶ ci の実行は、PR の head と同じリポジトリのものだけ', () => {
    const fork = { ...ci, id: 300, head_repository: { full_name: 'someone/project' } };
    const unknown = { ...ci, id: 301, head_repository: undefined };
    assert.deepEqual(selectCiRun(event, [ci, fork, unknown]), ci);
    assert.equal(selectCiRun(event, [fork, unknown]), undefined);
  });

  test('base は workflow_run の記録、無ければ API、pull_request ではイベントから取る', () => {
    const livePr = { ...pr, base: { ...pr.base, sha: 'c'.repeat(40) } };
    assert.equal(comparisonBaseSha(event, livePr), base);
    const recorded = (repo?: { id: number }) => workflowRun([{ number: pr.number, base: { sha: base, repo } }], {});
    assert.equal(comparisonBaseSha(recorded(sameRepo), livePr), base);
    assert.equal(comparisonBaseSha(workflowRun([]), livePr), livePr.base.sha);
    // 別のリポジトリの PR の base は、比べる main の SHA にしない
    assert.equal(comparisonBaseSha(recorded({ id: 1 }), livePr), livePr.base.sha);
    assert.equal(comparisonBaseSha(recorded(undefined), livePr), livePr.base.sha);
  });
});

test('画像の差分が無い場合と removed だけの場合は run=false', () => {
  const empty = { changed: [], added: [], removed: [], excluded: [] };
  assert.equal(decideScreens(empty).run, false);
  assert.equal(decideScreens({ ...empty, removed: ['screen/evidence-1.png'] }).run, false);
  assert.equal(decideScreens({ ...empty, added: [{ key: 'screen/evidence-1.png', after: head }] }).run, true);
  assert.equal(
    decideScreens({ ...empty, changed: [{ key: 'screen/evidence-1.png', before: base, after: head }] }).run,
    true,
  );
});

test('CLI はページをまたぐジョブとコメントを全て判定し、未完了の ci は失敗にしない', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-decide-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const save = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value));
  save('event.json', event);
  save('pr.json', pr);
  save('ci.json', ci);
  save('jobs.json', [{ jobs: input().jobs }, { jobs: [{ name: 'e2e (3)', conclusion: 'failure' }] }]);
  save('comments.json', [[]]);
  const call = (mode: string) => {
    const result = spawnSync(process.execPath, ['scripts/evidence-review-decide.ts', mode, dir], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: join(dir, 'event.json'),
        GITHUB_REPOSITORY: 'example/project',
        EVIDENCE_MAIN_PUBLIC_URL: 'https://example.test',
        GITHUB_OUTPUT: '',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.match(call('decide'), /run=false/);
  save('jobs.json', [{ jobs: input().jobs.slice(0, 1) }, { jobs: input().jobs.slice(1) }]);
  assert.match(call('decide'), /run=true/);
  save('comments.json', [[], [{ body: EVIDENCE_REVIEW_MARKER, user: { login: 'github-actions[bot]' } }]]);
  assert.match(call('decide'), /run=false/);
  save('runs.json', [{ workflow_runs: [ci] }, { workflow_runs: [{ ...ci, id: 101, status: 'queued' }] }]);
  assert.match(call('ci'), /ci_run_id=\n/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'ci.json'), 'utf8')).id, 101);
  save('runs.json', []);
  assert.match(call('ci'), /run=false/);
});

function cli(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-decide-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const save = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value));
  const call = (mode: string, mainUrl = 'https://example.test') => {
    const result = spawnSync(process.execPath, ['scripts/evidence-review-decide.ts', mode, dir], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: join(dir, 'event.json'),
        GITHUB_REPOSITORY: 'example/project',
        EVIDENCE_MAIN_PUBLIC_URL: mainUrl,
        GITHUB_OUTPUT: '',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  return { save, call };
}

test('CLI の resolve は workflow_run の pull_requests が空でも、2ページの候補から main 向けの PR を選ぶ', (t) => {
  const { save, call } = cli(t);
  save('event.json', workflowRun([]));
  const child = { ...pr, number: 531, base: { ...pr.base, ref: 'parent-branch' } };
  const unrelated = { ...pr, number: 1, head: { ...pr.head, sha: base } };
  save('candidates.json', [[unrelated, child], [pr]]);
  assert.match(call('resolve'), /pr_number=532\n/);
  save('candidates.json', [[unrelated], []]);
  assert.match(call('resolve'), /pr_number=\n/);
});

test('CLI の decide は公開 URL が空のときだけ、判定を飛ばす注記を出す', (t) => {
  const { save, call } = cli(t);
  save('event.json', event);
  save('pr.json', pr);
  save('ci.json', ci);
  save('jobs.json', [{ jobs: input().jobs }]);
  save('comments.json', [[]]);
  assert.doesNotMatch(call('decide'), /::notice/);
  assert.match(call('decide', ''), /::notice title=画面の判定を飛ばす::EVIDENCE_MAIN_PUBLIC_URL が空/);
  save('pr.json', { ...pr, draft: true });
  const output = call('decide', '');
  assert.match(output, /run=false: ドラフト/);
  assert.doesNotMatch(output, /::notice/);
});
