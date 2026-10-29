import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
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
const ci = { id: 100, head_sha: head, status: 'completed', event: 'pull_request' };
const event: ReviewEvent = { action: 'ready_for_review', pull_request: pr };
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
    for (const automatic of [event, { workflow_run: { ...ci, pull_requests: [{ number: pr.number }] } }]) {
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

  test('公開 URL が空なら止める', () => {
    for (const mainUrl of ['', '  ']) assert.equal(decideReview({ ...input(), mainUrl }).run, false);
  });
});

describe('PR と ci の選択', () => {
  test('イベントの最初の PR を優先し、無ければ同じ head の開いた PR を使う', () => {
    assert.equal(resolvePrNumber(event, []), pr.number);
    assert.equal(resolvePrNumber({ workflow_run: { ...ci, pull_requests: [{ number: 7 }, { number: 8 }] } }, [pr]), 7);
    const workflow = { workflow_run: { ...ci, pull_requests: [] } };
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

  test('最新の ci が未完了でも、古い成功へ戻さない', () => {
    const newer = { ...ci, id: 101, status: 'in_progress' };
    assert.deepEqual(
      selectCiRun(event, [ci, newer, { ...ci, id: 102, head_sha: base }, { ...ci, id: 103, event: 'push' }]),
      newer,
    );
    assert.equal(selectCiRun(event, []), undefined);
    assert.deepEqual(selectCiRun({ workflow_run: { ...ci, pull_requests: [] } }, [newer]), {
      ...ci,
      pull_requests: [],
    });
  });

  test('base は workflow_run の記録、無ければ API、pull_request ではイベントから取る', () => {
    const livePr = { ...pr, base: { ...pr.base, sha: 'c'.repeat(40) } };
    assert.equal(comparisonBaseSha(event, livePr), base);
    assert.equal(
      comparisonBaseSha(
        { workflow_run: { ...ci, pull_requests: [{ number: pr.number, base: { sha: base } }] } },
        livePr,
      ),
      base,
    );
    assert.equal(comparisonBaseSha({ workflow_run: { ...ci, pull_requests: [] } }, livePr), livePr.base.sha);
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
