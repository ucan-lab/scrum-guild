// node --test .claude/hooks/*.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as rules from './review-budget-rules.mjs';

const hooks = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(hooks, 'review-budget.mjs');
const { REVIEW_AGENTS, WINDOW_MS, BASE_LIMIT } = rules;
const T0 = 1_700_000_000_000;

describe('review-budget-rules（純関数）', () => {
  // 入れ物の throw を判定の失敗として見せ、テスト単位で落とす
  const emptyState = () => rules.emptyState();
  const judge = (state, agent, now) => rules.judgeReview(state, agent, now);

  // 起動を順に流し、拒否は記録しない。各起動の判定を返す
  const run = (events, state = emptyState()) => {
    const decisions = [];
    for (const [agent, at] of events) {
      const r = judge(state, agent, at);
      decisions.push(r.decision);
      state = r.state;
    }
    return { decisions, state };
  };

  describe('完了条件', () => {
    test('定数は仕様どおり（対象5種、窓 120 秒、既定の上限 2 巡）', () => {
      assert.deepEqual([...REVIEW_AGENTS].sort(), ['code-reviewer', 'database-reviewer', 'falsification-qa', 'security-reviewer', 'ui-reviewer']);
      assert.equal(WINDOW_MS, 120000);
      assert.equal(BASE_LIMIT, 2);
    });
    test('空の状態は starts が空で extra が 0', () => {
      assert.deepEqual(emptyState(), { starts: [], extra: 0 });
    });
    test('最初の起動は許可し、巡の最初の時刻を starts に記録する', () => {
      const r = judge(emptyState(), 'code-reviewer', T0);
      assert.equal(r.decision, 'allow');
      assert.deepEqual(r.state.starts, [T0]);
    });
    test('1 巡目と 2 巡目は許可し、2 巡を数える', () => {
      const { decisions, state } = run([
        ['code-reviewer', T0],
        ['code-reviewer', T0 + 10 * 60_000],
      ]);
      assert.deepEqual(decisions, ['allow', 'allow']);
      assert.deepEqual(state.starts, [T0, T0 + 10 * 60_000]);
    });
    test('延長は extra に加算し、extensions に巡数と理由と時刻を追記する', () => {
      let s = rules.extendState(emptyState(), 1, '設計が変わった', T0);
      s = rules.extendState(s, 2, 'もう一度', T0 + 1);
      assert.equal(s.extra, 3);
      assert.deepEqual(s.extensions, [
        { rounds: 1, reason: '設計が変わった', at: T0 },
        { rounds: 2, reason: 'もう一度', at: T0 + 1 },
      ]);
    });
    test('延長は元の state を書き換えない', () => {
      const before = emptyState();
      const copy = structuredClone(before);
      rules.extendState(before, 1, 'r', T0);
      assert.deepEqual(before, copy);
    });
    test('延長した分だけ起動できる（上限 2 + 1 で 3 巡目が通り、4 巡目は拒否）', () => {
      const s = rules.extendState(emptyState(), 1, 'r', T0);
      const { decisions } = run(
        [
          ['code-reviewer', T0],
          ['code-reviewer', T0 + 10 * 60_000],
          ['code-reviewer', T0 + 20 * 60_000],
          ['code-reviewer', T0 + 30 * 60_000],
        ],
        s,
      );
      assert.deepEqual(decisions, ['allow', 'allow', 'allow', 'deny']);
    });
    test('branchFileName はファイル名として安全で、同じ入力に同じ名前を返す', () => {
      for (const b of ['main', 'claude/increment-build-487-review-budget', '487-a b', 'x\\y', '日本語/ブランチ', '..', 'a:b*c?']) {
        const f = rules.branchFileName(b);
        assert.match(f, /^[^/\\\0]+$/, b);
        assert.notEqual(f, '.', b);
        assert.notEqual(f, '..', b);
        assert.equal(rules.branchFileName(b), f);
      }
    });
  });

  describe('拒否', () => {
    const two = () =>
      run([
        ['code-reviewer', T0],
        ['security-reviewer', T0 + 10 * 60_000],
      ]).state;

    test('3 巡目の最初の起動を拒否し、理由に上限・AskUserQuestion・extend・回避の禁止を含める', () => {
      const r = judge(two(), 'database-reviewer', T0 + 20 * 60_000);
      assert.equal(r.decision, 'deny');
      assert.equal(typeof r.reason, 'string');
      assert.match(r.reason, /2/);
      assert.match(r.reason, /AskUserQuestion/);
      assert.match(r.reason, /node \.claude\/hooks\/review-budget\.mjs extend <巡数> --reason <理由>/);
      assert.match(r.reason, /回避|名前を変え|呼び直/);
    });
    test('拒否では state を変えない', () => {
      const s = two();
      const copy = structuredClone(s);
      const r = judge(s, 'ui-reviewer', T0 + 20 * 60_000);
      assert.equal(r.decision, 'deny');
      assert.deepEqual(r.state, copy);
      assert.deepEqual(s, copy);
    });
    test('拒否した起動は記録せず、延長した分だけ後で起動できる', () => {
      let { state } = run([
        ['code-reviewer', T0],
        ['code-reviewer', T0 + 10 * 60_000],
        ['code-reviewer', T0 + 20 * 60_000], // 拒否
        ['code-reviewer', T0 + 21 * 60_000], // 拒否
      ]);
      assert.equal(state.starts.length, 2);
      state = rules.extendState(state, 1, 'r', T0 + 22 * 60_000);
      const { decisions } = run(
        [
          ['code-reviewer', T0 + 23 * 60_000],
          ['code-reviewer', T0 + 40 * 60_000],
        ],
        state,
      );
      assert.deepEqual(decisions, ['allow', 'deny']);
    });
    test('どの対象の agentType でも 3 巡目は拒否する', () => {
      for (const agent of ['code-reviewer', 'security-reviewer', 'database-reviewer', 'ui-reviewer']) {
        assert.equal(judge(two(), agent, T0 + 20 * 60_000).decision, agent ? 'deny' : 'allow', agent);
      }
    });
  });

  describe('すり抜け/境界', () => {
    test('120000ms ちょうどは同じ巡、超えたら新しい巡', () => {
      const same = judge(judge(emptyState(), 'code-reviewer', T0).state, 'code-reviewer', T0 + WINDOW_MS);
      assert.equal(same.decision, 'allow');
      assert.deepEqual(same.state.starts, [T0]);
      const next = judge(judge(emptyState(), 'code-reviewer', T0).state, 'code-reviewer', T0 + WINDOW_MS + 1);
      assert.equal(next.decision, 'allow');
      assert.deepEqual(next.state.starts, [T0, T0 + WINDOW_MS + 1]);
    });
    test('窓は巡の最初の起動から測る（起動のたびに延びない）', () => {
      // T0 の巡。+100s は同じ巡、+200s は最初から 120s を超えるので新しい巡
      const { state } = run([
        ['code-reviewer', T0],
        ['code-reviewer', T0 + 100_000],
        ['code-reviewer', T0 + 200_000],
      ]);
      assert.deepEqual(state.starts, [T0, T0 + 200_000]);
    });
    test('同じ巡の複数エージェントは何人でも拒否されない（上限に達した後の巡の中でも）', () => {
      const events = [
        ['code-reviewer', T0],
        ['security-reviewer', T0 + 1000],
        ['database-reviewer', T0 + 2000],
        ['ui-reviewer', T0 + 3000],
        ['code-reviewer', T0 + 10 * 60_000],
        ['security-reviewer', T0 + 10 * 60_000 + 500],
        ['ui-reviewer', T0 + 10 * 60_000 + WINDOW_MS],
      ];
      const { decisions, state } = run(events);
      assert.deepEqual(decisions, Array(7).fill('allow'));
      assert.deepEqual(state.starts, [T0, T0 + 10 * 60_000]);
    });
    test('上限に達した後、新しい巡の窓は拒否で始まらない（拒否は窓を開かない）', () => {
      // 3 巡目の拒否の直後 100s の起動も、拒否された巡の続きとして通ることはない
      const { decisions } = run([
        ['code-reviewer', T0],
        ['code-reviewer', T0 + 10 * 60_000],
        ['code-reviewer', T0 + 20 * 60_000],
        ['code-reviewer', T0 + 20 * 60_000 + 50_000],
      ]);
      assert.deepEqual(decisions, ['allow', 'allow', 'deny', 'deny']);
    });
    test('対象外の agentType は数えず、拒否もしない（上限に達していても）', () => {
      const full = run([
        ['code-reviewer', T0],
        ['code-reviewer', T0 + 10 * 60_000],
      ]).state;
      for (const agent of ['finding-verifier', 'Explore', 'general-purpose', '', undefined, null, 'Code-Reviewer', 'code-reviewer ']) {
        const r = judge(full, agent, T0 + 20 * 60_000);
        assert.equal(r.decision, 'allow', String(agent));
        assert.deepEqual(r.state, full, String(agent));
      }
      const fresh = judge(emptyState(), 'Explore', T0);
      assert.deepEqual(fresh.state, emptyState());
    });
    test('対象外の起動は窓を開かない（その後の最初の対象は新しい巡として数える）', () => {
      const { state } = run([
        ['Explore', T0],
        ['code-reviewer', T0 + 1000],
      ]);
      assert.deepEqual(state.starts, [T0 + 1000]);
    });
    test('時刻が巻き戻っても（負の差）同じ巡として扱い、壊れない', () => {
      const r = judge(judge(emptyState(), 'code-reviewer', T0).state, 'code-reviewer', T0 - 5000);
      assert.equal(r.decision, 'allow');
      assert.equal(r.state.starts.length, 1);
    });
    test('branchFileName は / を含む名前でも衝突しない', () => {
      const names = ['feature/a', 'feature%2Fa', 'feature-a', 'feature_a', 'feature//a', 'feature/a/', '/feature/a', 'Feature/a', 'a/b/c', 'a%2Fb/c', 'a/b%2Fc'];
      const files = names.map((n) => rules.branchFileName(n));
      assert.equal(new Set(files).size, names.length, files.join(','));
      for (const f of files) assert.ok(!f.includes('/'), f);
    });
  });

  describe('延長の検証', () => {
    test('extendState は延長を足しても starts を保つ', () => {
      const s = run([['code-reviewer', T0]]).state;
      const e = rules.extendState(s, 2, 'r', T0 + 1);
      assert.deepEqual(e.starts, [T0]);
      assert.equal(e.extra, 2);
    });
  });

  describe('falsification-qa（Issue #488）', () => {
    test('falsification-qa の最初の起動は許可し、巡として starts に記録する', () => {
      const r = judge(emptyState(), 'falsification-qa', T0);
      assert.equal(r.decision, 'allow');
      assert.deepEqual(r.state.starts, [T0]);
    });
    test('ほかのレビューのエージェントと 120 秒以内に呼ばれたら同じ 1 巡に数える', () => {
      for (const first of ['code-reviewer', 'security-reviewer', 'database-reviewer', 'ui-reviewer']) {
        const { decisions, state } = run([
          [first, T0],
          ['falsification-qa', T0 + WINDOW_MS],
        ]);
        assert.deepEqual(decisions, ['allow', 'allow'], first);
        assert.deepEqual(state.starts, [T0], first);
      }
      // falsification-qa が先でも、後のレビューのエージェントは同じ巡
      const { state } = run([
        ['falsification-qa', T0],
        ['code-reviewer', T0 + 1000],
      ]);
      assert.deepEqual(state.starts, [T0]);
    });
    test('falsification-qa だけで 2 巡を数え、上限に達した後の新しい巡は拒否する', () => {
      const { decisions, state } = run([
        ['falsification-qa', T0],
        ['falsification-qa', T0 + 10 * 60_000],
        ['falsification-qa', T0 + 20 * 60_000],
      ]);
      assert.deepEqual(decisions, ['allow', 'allow', 'deny']);
      assert.deepEqual(state.starts, [T0, T0 + 10 * 60_000]);
    });
    test('ほかのレビューのエージェントで上限に達した後の falsification-qa の新しい巡は拒否し、理由に手順を入れる', () => {
      const full = run([
        ['code-reviewer', T0],
        ['security-reviewer', T0 + 10 * 60_000],
      ]).state;
      const copy = structuredClone(full);
      const r = judge(full, 'falsification-qa', T0 + 20 * 60_000);
      assert.equal(r.decision, 'deny');
      assert.match(r.reason, /AskUserQuestion/);
      assert.match(r.reason, /node \.claude\/hooks\/review-budget\.mjs extend <巡数> --reason <理由>/);
      assert.deepEqual(r.state, copy);
    });
    test('finding-verifier は falsification-qa と並んでも数えない（上限に達していても拒否しない）', () => {
      const full = run([
        ['falsification-qa', T0],
        ['falsification-qa', T0 + 10 * 60_000],
      ]).state;
      const r = judge(full, 'finding-verifier', T0 + 20 * 60_000);
      assert.equal(r.decision, 'allow');
      assert.deepEqual(r.state, full);
      assert.deepEqual(judge(emptyState(), 'finding-verifier', T0).state, emptyState());
    });
    test('似た名前（前後の空白、大文字、接尾辞、プラグインの接頭辞）は数えない', () => {
      // このリポジトリのエージェントは .claude/agents/ の素の名前で呼ばれるので、完全一致だけを数える
      const full = run([
        ['code-reviewer', T0],
        ['code-reviewer', T0 + 10 * 60_000],
      ]).state;
      for (const agent of ['falsification-qa ', ' falsification-qa', 'Falsification-QA', 'FALSIFICATION-QA', 'falsification-qa-v2', 'ucan:falsification-qa', 'falsification_qa']) {
        const r = judge(full, agent, T0 + 20 * 60_000);
        assert.equal(r.decision, 'allow', JSON.stringify(agent));
        assert.deepEqual(r.state, full, JSON.stringify(agent));
        assert.deepEqual(judge(emptyState(), agent, T0).state, emptyState(), JSON.stringify(agent));
      }
    });
  });
});

describe('review-budget.mjs（入口を実際に起動する）', () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'review-budget-')));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'REVIEW_BUDGET_NOW' && key !== 'CLAUDE_CODE_REMOTE'),
  );
  const git = (args, cwd) => {
    const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
      env: cleanEnv,
    });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  let seq = 0;
  // 一時リポジトリ。初期ブランチは trunk
  const makeRepo = () => {
    const dir = path.join(tmp, `repo${++seq}`);
    mkdirSync(dir);
    git(['init', '-q', '-b', 'trunk'], dir);
    git(['commit', '-q', '--allow-empty', '-m', 'init'], dir);
    return dir;
  };
  const inputOf = (cwd, subagent_type, extra = {}) =>
    JSON.stringify({ tool_name: 'Agent', cwd, tool_input: { subagent_type, prompt: 'レビューして', ...extra } });
  const envAt = (now) => ({ ...cleanEnv, REVIEW_BUDGET_NOW: String(now) });
  const call = (cwd, agent, now, input = inputOf(cwd, agent)) =>
    spawnSync(process.execPath, [script], { input, cwd, encoding: 'utf8', env: envAt(now) });
  const extend = (cwd, args, now = T0) =>
    spawnSync(process.execPath, [script, 'extend', ...args], { cwd, encoding: 'utf8', env: envAt(now) });
  const denied = (r) => {
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    return out.hookSpecificOutput.permissionDecisionReason;
  };
  const allowed = (r) => {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '', '許可は出力なし');
  };
  const budgetDir = (repo) => path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo), 'review-budget');
  const stateFiles = (repo) => (existsSync(budgetDir(repo)) ? readdirSync(budgetDir(repo)) : []);
  const MIN = 60_000;

  describe('完了条件', () => {
    test('入口は存在し、起動で import の失敗でなく判定に進む（許可は出力なしで exit 0）', () => {
      const repo = makeRepo();
      allowed(call(repo, 'code-reviewer', T0));
    });
    test('2 巡は通り、3 巡目の最初の起動が拒否される。理由に手順が入る', () => {
      const repo = makeRepo();
      allowed(call(repo, 'code-reviewer', T0));
      allowed(call(repo, 'security-reviewer', T0 + 10 * MIN));
      const reason = denied(call(repo, 'database-reviewer', T0 + 20 * MIN));
      assert.match(reason, /2/);
      assert.match(reason, /AskUserQuestion/);
      assert.match(reason, /node \.claude\/hooks\/review-budget\.mjs extend <巡数> --reason <理由>/);
      assert.match(reason, /回避|名前を変え|呼び直/);
    });
    test('状態は git の common-dir の review-budget/ に、ブランチごとの 1 ファイルで JSON として置く', () => {
      const repo = makeRepo();
      allowed(call(repo, 'code-reviewer', T0));
      const files = stateFiles(repo);
      assert.equal(files.length, 1, files.join(','));
      assert.equal(files[0], `${rules.branchFileName('trunk')}.json`);
      const state = JSON.parse(readFileSync(path.join(budgetDir(repo), files[0]), 'utf8'));
      assert.deepEqual(state.starts, [T0]);
    });
    test('プロセスを終えて再実行しても巡の数が保たれる（拒否は記録されない）', () => {
      const repo = makeRepo();
      allowed(call(repo, 'code-reviewer', T0));
      allowed(call(repo, 'code-reviewer', T0 + 10 * MIN));
      denied(call(repo, 'code-reviewer', T0 + 20 * MIN));
      denied(call(repo, 'code-reviewer', T0 + 21 * MIN));
      const state = JSON.parse(readFileSync(path.join(budgetDir(repo), stateFiles(repo)[0]), 'utf8'));
      assert.equal(state.starts.length, 2);
    });
    test('extend で上限が増え、延長した分だけ通り、その次は拒否される', () => {
      const repo = makeRepo();
      allowed(call(repo, 'code-reviewer', T0));
      allowed(call(repo, 'code-reviewer', T0 + 10 * MIN));
      denied(call(repo, 'code-reviewer', T0 + 20 * MIN));
      const e = extend(repo, ['1', '--reason', '設計を変えた'], T0 + 21 * MIN);
      assert.equal(e.status, 0, e.stderr);
      allowed(call(repo, 'code-reviewer', T0 + 22 * MIN));
      denied(call(repo, 'code-reviewer', T0 + 40 * MIN));
      const state = JSON.parse(readFileSync(path.join(budgetDir(repo), stateFiles(repo)[0]), 'utf8'));
      assert.equal(state.extra, 1);
      assert.equal(state.extensions[0].rounds, 1);
      assert.equal(state.extensions[0].reason, '設計を変えた');
    });
    test('extend を 2 回行うと合計だけ増える', () => {
      const repo = makeRepo();
      assert.equal(extend(repo, ['1', '--reason', 'a']).status, 0);
      assert.equal(extend(repo, ['2', '--reason', 'b']).status, 0);
      const state = JSON.parse(readFileSync(path.join(budgetDir(repo), stateFiles(repo)[0]), 'utf8'));
      assert.equal(state.extra, 3);
      assert.equal(state.extensions.length, 2);
    });
    test('cwd がサブディレクトリでも同じブランチとして数える', () => {
      const repo = makeRepo();
      const sub = path.join(repo, 'a/b');
      mkdirSync(sub, { recursive: true });
      allowed(call(repo, 'code-reviewer', T0));
      allowed(call(sub, 'code-reviewer', T0 + 10 * MIN));
      denied(call(repo, 'code-reviewer', T0 + 20 * MIN));
    });
    test('入力の cwd を使う（プロセスの cwd が別のリポジトリでも、入力の cwd のブランチを数える）', () => {
      const repo = makeRepo();
      const other = makeRepo();
      const run1 = (at) => spawnSync(process.execPath, [script], { input: inputOf(repo, 'code-reviewer'), cwd: other, encoding: 'utf8', env: envAt(at) });
      allowed(run1(T0));
      allowed(run1(T0 + 10 * MIN));
      denied(run1(T0 + 20 * MIN));
      assert.deepEqual(stateFiles(other), []);
    });
  });

  describe('拒否', () => {
    test('拒否は exit 0 で stdout に PreToolUse の deny JSON だけを出す', () => {
      const repo = makeRepo();
      allowed(call(repo, 'code-reviewer', T0));
      allowed(call(repo, 'code-reviewer', T0 + 10 * MIN));
      const r = call(repo, 'ui-reviewer', T0 + 20 * MIN);
      denied(r);
      assert.deepEqual(Object.keys(JSON.parse(r.stdout)), ['hookSpecificOutput']);
    });
    test('ブランチが違えば別に数える（一方が上限でも他方は通る）', () => {
      const repo = makeRepo();
      allowed(call(repo, 'code-reviewer', T0));
      allowed(call(repo, 'code-reviewer', T0 + 10 * MIN));
      denied(call(repo, 'code-reviewer', T0 + 20 * MIN));
      git(['switch', '-q', '-c', '488-other'], repo);
      allowed(call(repo, 'code-reviewer', T0 + 21 * MIN));
      allowed(call(repo, 'code-reviewer', T0 + 40 * MIN));
      denied(call(repo, 'code-reviewer', T0 + 60 * MIN));
      git(['switch', '-q', 'trunk'], repo);
      denied(call(repo, 'code-reviewer', T0 + 61 * MIN));
    });
    test('別ワークツリーでも同じブランチは common-dir を共有して数える', () => {
      const repo = makeRepo();
      git(['switch', '-q', '-c', '487-x'], repo);
      git(['switch', '-q', 'trunk'], repo);
      const wt = path.join(tmp, `wt${++seq}`);
      git(['worktree', 'add', '-q', wt, '487-x'], repo);
      allowed(call(repo === wt ? repo : wt, 'code-reviewer', T0));
      // 同じブランチ名を別のワークツリーから数えるため、元のリポジトリを同じブランチへ切り替えられない。
      // 代わりにワークツリーのサブディレクトリと、common-dir の状態の位置で共有を確かめる
      allowed(call(wt, 'code-reviewer', T0 + 10 * MIN));
      denied(call(wt, 'code-reviewer', T0 + 20 * MIN));
      assert.deepEqual(stateFiles(repo), stateFiles(wt));
      assert.equal(stateFiles(repo).length, 1);
      // ワークツリーの中に状態を作らない
      assert.ok(!existsSync(path.join(wt, 'review-budget')));
    });
    test('ワークツリーをまたいで数える（ブランチを移して別のワークツリーから続ける）', () => {
      const repo = makeRepo();
      const wtA = path.join(tmp, `wt${++seq}`);
      const wtB = path.join(tmp, `wt${++seq}`);
      git(['worktree', 'add', '-q', wtA, '-b', '487-y'], repo);
      allowed(call(wtA, 'code-reviewer', T0));
      allowed(call(wtA, 'code-reviewer', T0 + 10 * MIN));
      // ワークツリー A を外して B に同じブランチを出す
      git(['worktree', 'remove', '--force', wtA], repo);
      git(['worktree', 'add', '-q', wtB, '487-y'], repo);
      denied(call(wtB, 'code-reviewer', T0 + 20 * MIN));
    });
    test('ブランチ名に / があっても、別ブランチと衝突せず、ファイルが入れ子にならない', () => {
      const repo = makeRepo();
      git(['switch', '-q', '-c', 'claude/increment-build-487'], repo);
      allowed(call(repo, 'code-reviewer', T0));
      allowed(call(repo, 'code-reviewer', T0 + 10 * MIN));
      denied(call(repo, 'code-reviewer', T0 + 20 * MIN));
      const dir = budgetDir(repo);
      for (const name of readdirSync(dir)) assert.ok(statSync(path.join(dir, name)).isFile(), `${name} は入れ子のディレクトリ`);
      assert.equal(stateFiles(repo).length, 1);
      // 同じ接頭辞の別ブランチや、% で /  を装う名前とは数えが別
      for (const other of ['claude.x', 'claude-increment-build-487', 'claude%2Fincrement-build-487']) {
        git(['switch', '-q', '-c', other, 'trunk'], repo);
        allowed(call(repo, 'code-reviewer', T0 + 30 * MIN));
        git(['switch', '-q', 'claude/increment-build-487'], repo);
      }
    });
    test('ブランチ名が / の有無だけ違う 2 つ（a/b と a-b 系の代表）を別に数える', () => {
      const repo = makeRepo();
      git(['switch', '-q', '-c', 'feature/a'], repo);
      allowed(call(repo, 'code-reviewer', T0));
      allowed(call(repo, 'code-reviewer', T0 + 10 * MIN));
      git(['switch', '-q', '-c', 'feature%2Fa', 'trunk'], repo);
      allowed(call(repo, 'code-reviewer', T0 + 20 * MIN));
      allowed(call(repo, 'code-reviewer', T0 + 30 * MIN));
      assert.equal(stateFiles(repo).length, 2);
    });
    test('REVIEW_BUDGET_NOW で時刻を進めると新しい巡になる（120 秒ちょうどは同じ巡）', () => {
      const repo = makeRepo();
      allowed(call(repo, 'code-reviewer', T0));
      allowed(call(repo, 'code-reviewer', T0 + WINDOW_MS)); // 同じ巡
      allowed(call(repo, 'code-reviewer', T0 + WINDOW_MS + 1)); // 2 巡目
      denied(call(repo, 'code-reviewer', T0 + 2 * WINDOW_MS + 2)); // 3 巡目
    });
  });

  describe('すり抜け/境界', () => {
    test('対象外の subagent_type は出力なしで exit 0、状態ファイルも作らない', () => {
      const repo = makeRepo();
      for (const agent of ['finding-verifier', 'Explore', 'general-purpose', '']) {
        allowed(call(repo, agent, T0));
      }
      allowed(call(repo, undefined, T0, JSON.stringify({ tool_name: 'Agent', cwd: repo, tool_input: { prompt: 'x' } })));
      assert.deepEqual(stateFiles(repo), []);
    });
    test('上限に達していても対象外は拒否されない', () => {
      const repo = makeRepo();
      allowed(call(repo, 'code-reviewer', T0));
      allowed(call(repo, 'code-reviewer', T0 + 10 * MIN));
      allowed(call(repo, 'finding-verifier', T0 + 20 * MIN));
      allowed(call(repo, 'Explore', T0 + 20 * MIN));
    });
    test('同じ巡の複数エージェントは拒否されない（上限に達した後の巡の中でも）', () => {
      const repo = makeRepo();
      allowed(call(repo, 'code-reviewer', T0));
      allowed(call(repo, 'code-reviewer', T0 + 10 * MIN));
      allowed(call(repo, 'security-reviewer', T0 + 10 * MIN + 1000));
      allowed(call(repo, 'database-reviewer', T0 + 10 * MIN + 2000));
      allowed(call(repo, 'ui-reviewer', T0 + 10 * MIN + WINDOW_MS));
      denied(call(repo, 'ui-reviewer', T0 + 10 * MIN + WINDOW_MS + 1));
    });
    test('detached HEAD では拒否せず数えない。状態ファイルも作らない', () => {
      const repo = makeRepo();
      git(['switch', '-q', '--detach'], repo);
      for (let i = 0; i < 4; i += 1) allowed(call(repo, 'code-reviewer', T0 + i * 10 * MIN));
      assert.deepEqual(stateFiles(repo), []);
    });
    test('git のリポジトリでない cwd でも拒否せず数えない', () => {
      const dir = path.join(tmp, `plain${++seq}`);
      mkdirSync(dir);
      for (let i = 0; i < 4; i += 1) allowed(call(dir, 'code-reviewer', T0 + i * 10 * MIN));
      assert.deepEqual(readdirSync(dir), []);
    });
    test('stdin が不正な JSON なら exit 2 で、stderr に理由を出す', () => {
      const repo = makeRepo();
      for (const input of ['', 'not json', '{', '[1,2']) {
        const r = call(repo, undefined, T0, input);
        assert.equal(r.status, 2, `${JSON.stringify(input)}: ${r.stderr}`);
        assert.notEqual(r.stderr.trim(), '');
        assert.equal(r.stdout.trim(), '');
      }
      assert.deepEqual(stateFiles(repo), []);
    });
    test('JSON でも object でない入力は exit 2', () => {
      const repo = makeRepo();
      for (const input of ['null', '42', '"x"']) {
        const r = call(repo, undefined, T0, input);
        assert.equal(r.status, 2, `${input}: ${r.stderr}`);
        assert.notEqual(r.stderr.trim(), '');
      }
    });
    test('extend は巡数が正の整数でないと非0で終わり、状態を変えない', () => {
      const repo = makeRepo();
      allowed(call(repo, 'code-reviewer', T0));
      const file = path.join(budgetDir(repo), stateFiles(repo)[0]);
      const before = readFileSync(file, 'utf8');
      for (const n of ['0', '-1', '1.5', 'abc', '', '1e2', ' ']) {
        const r = extend(repo, [n, '--reason', 'r']);
        assert.notEqual(r.status, 0, `巡数 ${JSON.stringify(n)}`);
        assert.notEqual(r.stderr.trim(), '');
      }
      assert.equal(readFileSync(file, 'utf8'), before);
    });
    test('extend は巡数の無い呼び出しも失敗する', () => {
      const repo = makeRepo();
      const r = spawnSync(process.execPath, [script, 'extend'], { cwd: repo, encoding: 'utf8', env: envAt(T0) });
      assert.notEqual(r.status, 0);
      assert.deepEqual(stateFiles(repo), []);
      assert.equal(extend(repo, ['1', '--reason', 'r']).status, 0, '正しい引数なら通る');
    });
    test('extend は理由が無い、または空だと非0で終わり、状態ファイルを作らない', () => {
      const repo = makeRepo();
      for (const args of [['1'], ['1', '--reason'], ['1', '--reason', ''], ['1', '--reason', '   '], ['1', '--other', 'x']]) {
        const r = extend(repo, args);
        assert.notEqual(r.status, 0, JSON.stringify(args));
        assert.notEqual(r.stderr.trim(), '');
      }
      assert.deepEqual(stateFiles(repo), []);
      assert.equal(extend(repo, ['1', '--reason', 'r']).status, 0, '正しい引数なら通る');
    });
    test('detached HEAD での extend は失敗する（ブランチが引けない）', () => {
      const repo = makeRepo();
      git(['switch', '-q', '--detach'], repo);
      const r = extend(repo, ['1', '--reason', 'r']);
      assert.notEqual(r.status, 0);
      assert.deepEqual(stateFiles(repo), []);
      git(['switch', '-q', 'trunk'], repo);
      assert.equal(extend(repo, ['1', '--reason', 'r']).status, 0, 'ブランチがあれば通る');
    });
    test('状態ファイルが壊れていても、黙って許可に倒さず exit 2 で止める', () => {
      const repo = makeRepo();
      allowed(call(repo, 'code-reviewer', T0));
      const file = path.join(budgetDir(repo), stateFiles(repo)[0]);
      spawnSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(file)}, '{broken')`]);
      const r = call(repo, 'code-reviewer', T0 + 10 * MIN);
      assert.equal(r.status, 2, r.stderr);
      assert.notEqual(r.stderr.trim(), '');
    });
    test('入力の tool_input に subagent_type が無くても落ちない（出力なしで exit 0）', () => {
      const repo = makeRepo();
      allowed(call(repo, undefined, T0, JSON.stringify({ tool_name: 'Agent', cwd: repo, tool_input: {} })));
    });
  });

  describe('並行', () => {
    const callAsync = (cwd, agent, now) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [script], { cwd, env: envAt(now) });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('close', (status) => resolve({ status, stdout, stderr }));
        child.stdin.end(inputOf(cwd, agent));
      });

    test('同時に 3 プロセスを起動しても 1 巡として数え、状態は壊れない', async () => {
      const repo = makeRepo();
      const results = await Promise.all([
        callAsync(repo, 'code-reviewer', T0),
        callAsync(repo, 'security-reviewer', T0 + 5),
        callAsync(repo, 'database-reviewer', T0 + 10),
      ]);
      for (const r of results) allowed(r);
      const files = stateFiles(repo);
      assert.equal(files.length, 1, files.join(','));
      const state = JSON.parse(readFileSync(path.join(budgetDir(repo), files[0]), 'utf8'));
      assert.equal(state.starts.length, 1);
      // 1 巡しか使っていないので、後の 2 巡目も通り、3 巡目だけが拒否される
      allowed(call(repo, 'code-reviewer', T0 + 10 * MIN));
      denied(call(repo, 'code-reviewer', T0 + 20 * MIN));
    });
    test('同じ時刻の同時 3 起動でも 1 巡', async () => {
      const repo = makeRepo();
      const results = await Promise.all(['code-reviewer', 'ui-reviewer', 'security-reviewer'].map((a) => callAsync(repo, a, T0)));
      for (const r of results) allowed(r);
      const state = JSON.parse(readFileSync(path.join(budgetDir(repo), stateFiles(repo)[0]), 'utf8'));
      assert.deepEqual(state.starts, [T0]);
    });
    test('上限に達した後の同時 3 起動は、すべて拒否され、状態は変わらない', async () => {
      const repo = makeRepo();
      allowed(call(repo, 'code-reviewer', T0));
      allowed(call(repo, 'code-reviewer', T0 + 10 * MIN));
      const file = path.join(budgetDir(repo), stateFiles(repo)[0]);
      const before = readFileSync(file, 'utf8');
      const results = await Promise.all(['code-reviewer', 'ui-reviewer', 'security-reviewer'].map((a) => callAsync(repo, a, T0 + 20 * MIN)));
      for (const r of results) denied(r);
      assert.equal(readFileSync(file, 'utf8'), before);
    });
    test('同時の別の巡 3 つ（時刻が離れた）は、上限の 2 巡だけが通る', async () => {
      const repo = makeRepo();
      const results = await Promise.all([
        callAsync(repo, 'code-reviewer', T0),
        callAsync(repo, 'code-reviewer', T0 + 10 * MIN),
        callAsync(repo, 'code-reviewer', T0 + 20 * MIN),
      ]);
      assert.equal(results.filter((r) => r.stdout.trim() === '').length, 2);
      assert.equal(results.filter((r) => r.stdout.includes('"deny"')).length, 1);
      const state = JSON.parse(readFileSync(path.join(budgetDir(repo), stateFiles(repo)[0]), 'utf8'));
      assert.equal(state.starts.length, 2);
    });
    test('同時の extend 3 つは、すべて足される', async () => {
      const repo = makeRepo();
      allowed(call(repo, 'code-reviewer', T0));
      const ext = () =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [script, 'extend', '1', '--reason', 'r'], { cwd: repo, env: envAt(T0) });
          child.on('close', resolve);
        });
      const codes = await Promise.all([ext(), ext(), ext()]);
      assert.deepEqual(codes, [0, 0, 0]);
      const state = JSON.parse(readFileSync(path.join(budgetDir(repo), stateFiles(repo)[0]), 'utf8'));
      assert.equal(state.extra, 3);
      assert.equal(state.extensions.length, 3);
    });
    test('ロックのファイルが状態の置き場に残らない（実行後は状態ファイルだけ）', async () => {
      const repo = makeRepo();
      await Promise.all([callAsync(repo, 'code-reviewer', T0), callAsync(repo, 'code-reviewer', T0 + 1)]);
      assert.deepEqual(
        stateFiles(repo).filter((f) => !f.endsWith('.json')),
        [],
      );
      assert.equal(stateFiles(repo).length, 1);
    });
  });

  describe('falsification-qa（Issue #488）', () => {
    const readState = (repo) => JSON.parse(readFileSync(path.join(budgetDir(repo), stateFiles(repo)[0]), 'utf8'));

    test('falsification-qa の起動を状態ファイルに巡として数える', () => {
      const repo = makeRepo();
      allowed(call(repo, 'falsification-qa', T0));
      assert.equal(stateFiles(repo).length, 1, '状態ファイルを作る');
      assert.deepEqual(readState(repo).starts, [T0]);
    });
    test('ほかのレビューのエージェントと 120 秒以内なら同じ 1 巡', () => {
      const repo = makeRepo();
      // falsification-qa が巡を開き、30 秒後の code-reviewer は同じ巡に入る
      allowed(call(repo, 'falsification-qa', T0));
      allowed(call(repo, 'code-reviewer', T0 + 30_000));
      assert.deepEqual(readState(repo).starts, [T0]);
    });
    test('falsification-qa で上限を超えると deny を返し、状態を変えない', () => {
      const repo = makeRepo();
      allowed(call(repo, 'falsification-qa', T0));
      allowed(call(repo, 'falsification-qa', T0 + 10 * MIN));
      assert.equal(stateFiles(repo).length, 1, '2 巡を状態ファイルに数える');
      assert.equal(readState(repo).starts.length, 2);
      const before = readFileSync(path.join(budgetDir(repo), stateFiles(repo)[0]), 'utf8');
      const reason = denied(call(repo, 'falsification-qa', T0 + 20 * MIN));
      assert.match(reason, /AskUserQuestion/);
      assert.equal(readFileSync(path.join(budgetDir(repo), stateFiles(repo)[0]), 'utf8'), before);
    });
    test('ほかのレビューのエージェントで上限に達した後の falsification-qa は deny', () => {
      const repo = makeRepo();
      allowed(call(repo, 'code-reviewer', T0));
      allowed(call(repo, 'security-reviewer', T0 + 10 * MIN));
      const r = call(repo, 'falsification-qa', T0 + 20 * MIN);
      assert.notEqual(r.stdout.trim(), '', '拒否の JSON を出す（出力なしは許可）');
      denied(r);
    });
    test('finding-verifier と似た名前は数えず、上限に達していても拒否しない', () => {
      const repo = makeRepo();
      for (const agent of ['finding-verifier', 'falsification-qa ', 'Falsification-QA', 'falsification-qa-v2', 'ucan:falsification-qa']) {
        allowed(call(repo, agent, T0));
      }
      assert.deepEqual(stateFiles(repo), [], '対象外だけなら状態ファイルを作らない');
      allowed(call(repo, 'code-reviewer', T0));
      allowed(call(repo, 'code-reviewer', T0 + 10 * MIN));
      for (const agent of ['finding-verifier', 'falsification-qa ', 'Falsification-QA', 'falsification-qa-v2', 'ucan:falsification-qa']) {
        allowed(call(repo, agent, T0 + 20 * MIN));
      }
      assert.equal(readState(repo).starts.length, 2);
    });
  });
});

// ---- 追加の攻撃（Issue #487 の仕様に反する実装の欠陥を探す）----
import { utimesSync, writeFileSync } from 'node:fs';

describe('review-budget.mjs（崩す手口の追加）', () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'review-budget-atk-')));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'REVIEW_BUDGET_NOW' && key !== 'CLAUDE_CODE_REMOTE'),
  );
  const git = (args, cwd) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
      env: cleanEnv,
    });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  let n = 0;
  const makeRepo = () => {
    const dir = path.join(tmp, `r${++n}`);
    mkdirSync(dir);
    git(['init', '-q', '-b', 'trunk'], dir);
    git(['commit', '-q', '--allow-empty', '-m', 'init'], dir);
    return dir;
  };
  const MIN = 60_000;
  const envAt = (now) => ({ ...cleanEnv, REVIEW_BUDGET_NOW: String(now) });
  const call = (cwd, agent, now, input) =>
    spawnSync(process.execPath, [script], {
      input: input ?? JSON.stringify({ tool_name: 'Agent', cwd, tool_input: { subagent_type: agent } }),
      cwd,
      encoding: 'utf8',
      env: envAt(now),
    });
  const extend = (cwd, args, now = T0) => spawnSync(process.execPath, [script, 'extend', ...args], { cwd, encoding: 'utf8', env: envAt(now) });
  const bdir = (repo) => path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo), 'review-budget');
  const isDeny = (r) => r.status === 0 && r.stdout.includes('"deny"');
  const isAllow = (r) => r.status === 0 && r.stdout.trim() === '';
  const stateFile = (repo, branch = 'trunk') => path.join(bdir(repo), `${rules.branchFileName(branch)}.json`);
  const seed = (repo, body, branch = 'trunk') => {
    mkdirSync(bdir(repo), { recursive: true });
    writeFileSync(stateFile(repo, branch), typeof body === 'string' ? body : JSON.stringify(body));
  };

  test('状態ファイルが空だと exit 2（許可に倒さない）', () => {
    const repo = makeRepo();
    seed(repo, '');
    const r = call(repo, 'code-reviewer', T0);
    assert.equal(r.status, 2, r.stderr);
  });
  test('状態ファイルが JSON の配列・null・文字列でも exit 2', () => {
    for (const body of ['[]', 'null', '"x"', '{}', '{"starts":{},"extra":0}']) {
      const repo = makeRepo();
      seed(repo, body);
      assert.equal(call(repo, 'code-reviewer', T0).status, 2, body);
    }
  });
  test('extra が文字列・null・真偽値の状態は exit 2', () => {
    for (const extra of ['1', null, true, [1]]) {
      const repo = makeRepo();
      seed(repo, { starts: [], extra });
      assert.equal(call(repo, 'code-reviewer', T0).status, 2, JSON.stringify(extra));
    }
  });
  test('巨大な状態ファイル（空白 5MB 入りの正しい JSON）でも正しく判定する', () => {
    const repo = makeRepo();
    seed(repo, `${' '.repeat(5_000_000)}{"starts":[${T0},${T0 + 10 * MIN}],"extra":0}`);
    assert.ok(isDeny(call(repo, 'code-reviewer', T0 + 20 * MIN)));
    assert.ok(isAllow(call(repo, 'code-reviewer', T0 + 10 * MIN + 1000)));
  });
  test('starts が数値でない要素を含む状態は、巡として数えず exit 2 で止める', () => {
    // 仕様「判定できないときは exit 2」。starts に文字列があると Math.abs(NaN) で窓判定が常に偽になり、
    // 壊れた要素が 1 巡として数えられて正当な起動を拒否する（または黙って数える）
    for (const starts of [['a', 'b'], [null, null], [{}, []], [true, false]]) {
      const repo = makeRepo();
      seed(repo, { starts, extra: 0 });
      const r = call(repo, 'code-reviewer', T0);
      assert.equal(r.status, 2, `${JSON.stringify(starts)}: 出力 ${r.stdout}`);
    }
  });
  test('extra が負の状態は exit 2 で止める（上限が 2 未満に縮んで 1 巡目から拒否されない）', () => {
    // 仕様: 上限は 2 巡 + 延長。延長は正の整数だけなので負の extra は壊れた状態であり、判定できない
    const repo = makeRepo();
    seed(repo, { starts: [], extra: -5 });
    const r = call(repo, 'code-reviewer', T0);
    assert.equal(r.status, 2, `status ${r.status} stdout ${r.stdout}`);
  });
  test('extra が小数の状態は exit 2 で止める', () => {
    // 仕様: 延長は巡数（整数）。1.5 のような extra は判定できない状態
    const repo = makeRepo();
    seed(repo, { starts: [T0, T0 + 10 * MIN], extra: 0.5 });
    const r = call(repo, 'code-reviewer', T0 + 20 * MIN);
    assert.ok(r.status === 2 || isDeny(r), `status ${r.status} stdout ${r.stdout}`);
  });
  test('桁の多すぎる巡数の extend で状態を壊さない（以後のフックが exit 2 で固まらない）', () => {
    // 仕様: 延長した分だけ起動できる。400 桁の巡数は Number() で Infinity になり JSON では null になって、
    // 以後すべてのレビュー起動が exit 2 になる。extend を拒否するか、状態を使える形に保つこと
    const repo = makeRepo();
    const e = extend(repo, ['9'.repeat(400), '--reason', 'r']);
    const r = call(repo, 'code-reviewer', T0);
    assert.ok(e.status !== 0 || r.status === 0, `extend ${e.status}、その後のフック ${r.status}: ${r.stderr}`);
  });
  test('extend は --reason の後ろに余分な引数があると失敗し、状態を作らない', () => {
    const repo = makeRepo();
    for (const args of [['1', '--reason', 'a', 'b'], ['1', '--reason', 'a', '--reason', 'b'], ['--reason', 'a', '1']]) {
      assert.notEqual(extend(repo, args).status, 0, JSON.stringify(args));
    }
    assert.equal(existsSync(stateFile(repo)), false);
  });
  test('extend は壊れた状態ファイルを上書きせず失敗する', () => {
    const repo = makeRepo();
    seed(repo, '{broken');
    assert.notEqual(extend(repo, ['1', '--reason', 'r']).status, 0);
    assert.equal(readFileSync(stateFile(repo), 'utf8'), '{broken');
  });
  test('extend は拒否を記録せず starts を保ち、延長の at に渡した時刻を残す', () => {
    const repo = makeRepo();
    assert.ok(isAllow(call(repo, 'code-reviewer', T0)));
    assert.equal(extend(repo, ['1', '--reason', 'x'], T0 + 5 * MIN).status, 0);
    const s = JSON.parse(readFileSync(stateFile(repo), 'utf8'));
    assert.deepEqual(s.starts, [T0]);
    assert.equal(s.extensions[0].at, T0 + 5 * MIN);
  });
  test('入力の subagent_type が配列・数・null・オブジェクトでも数えず許可する（上限到達後も）', () => {
    const repo = makeRepo();
    seed(repo, { starts: [T0, T0 + 10 * MIN], extra: 0 });
    const before = readFileSync(stateFile(repo), 'utf8');
    for (const t of [['code-reviewer'], 1, null, { a: 1 }, true]) {
      assert.ok(isAllow(call(repo, undefined, T0 + 20 * MIN, JSON.stringify({ cwd: repo, tool_input: { subagent_type: t } }))), JSON.stringify(t));
    }
    for (const t of ['CODE-REVIEWER', ' code-reviewer', 'code-reviewer\n', 'code_reviewer', 'code-reviewer2']) {
      assert.ok(isAllow(call(repo, t, T0 + 20 * MIN)), JSON.stringify(t));
    }
    assert.equal(readFileSync(stateFile(repo), 'utf8'), before);
  });
  test('tool_input が無い・配列・文字列の入力でも落ちない（対象外として許可）', () => {
    const repo = makeRepo();
    for (const input of ['{}', '{"tool_input":null}', '{"tool_input":[]}', '{"tool_input":"code-reviewer"}']) {
      assert.ok(isAllow(call(repo, undefined, T0, input)), input);
    }
    assert.equal(existsSync(bdir(repo)), false);
  });
  test('入力に cwd が無いときはプロセスの cwd のブランチで数える', () => {
    const repo = makeRepo();
    const noCwd = (at) => call(repo, undefined, at, JSON.stringify({ tool_input: { subagent_type: 'code-reviewer' } }));
    assert.ok(isAllow(noCwd(T0)));
    assert.ok(isAllow(noCwd(T0 + 10 * MIN)));
    assert.ok(isDeny(noCwd(T0 + 20 * MIN)));
  });
  test('入力の cwd が存在しないパスでも拒否せず、状態も作らない', () => {
    const repo = makeRepo();
    const ghost = path.join(tmp, 'no-such-dir');
    for (let i = 0; i < 4; i += 1) {
      assert.ok(isAllow(call(repo, 'code-reviewer', T0 + i * 10 * MIN, JSON.stringify({ cwd: ghost, tool_input: { subagent_type: 'code-reviewer' } }))));
    }
    assert.equal(existsSync(bdir(repo)), false);
  });
  test('古いロックが残っていても（30 秒より前）取り直して判定し、ロックを消す', () => {
    const repo = makeRepo();
    mkdirSync(bdir(repo), { recursive: true });
    const lock = path.join(bdir(repo), `${rules.branchFileName('trunk')}.lock`);
    mkdirSync(lock);
    const old = new Date(Date.now() - 5 * MIN);
    utimesSync(lock, old, old);
    assert.ok(isAllow(call(repo, 'code-reviewer', T0)));
    assert.equal(existsSync(lock), false);
    assert.deepEqual(JSON.parse(readFileSync(stateFile(repo), 'utf8')).starts, [T0]);
  });
  test('新しいロックが残っていると待った末に exit 2 で止め、他人のロックは消さない', () => {
    const repo = makeRepo();
    mkdirSync(bdir(repo), { recursive: true });
    const lock = path.join(bdir(repo), `${rules.branchFileName('trunk')}.lock`);
    mkdirSync(lock);
    const r = call(repo, 'code-reviewer', T0);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(existsSync(lock), true);
    assert.equal(existsSync(stateFile(repo)), false);
  });
  test('壊れた状態で止めた後もロックを残さない', () => {
    const repo = makeRepo();
    seed(repo, '{broken');
    assert.equal(call(repo, 'code-reviewer', T0).status, 2);
    assert.deepEqual(readdirSync(bdir(repo)).filter((f) => f.endsWith('.lock') || f.endsWith('.tmp')), []);
  });
  test('状態の置き場を作れない（同名のファイルがある）ときは exit 2', () => {
    const repo = makeRepo();
    const dir = bdir(repo);
    writeFileSync(dir, 'x');
    const r = call(repo, 'code-reviewer', T0);
    assert.equal(r.status, 2, r.stderr);
    assert.notEqual(r.stderr.trim(), '');
    assert.equal(extend(repo, ['1', '--reason', 'r']).status !== 0, true);
  });
  test('非 ASCII のブランチ名でもブランチごとに別の状態になる', () => {
    const repo = makeRepo();
    git(['switch', '-q', '-c', '487-日本語'], repo);
    assert.ok(isAllow(call(repo, 'code-reviewer', T0)));
    assert.ok(isAllow(call(repo, 'code-reviewer', T0 + 10 * MIN)));
    assert.ok(isDeny(call(repo, 'code-reviewer', T0 + 20 * MIN)));
    git(['switch', '-q', 'trunk'], repo);
    assert.ok(isAllow(call(repo, 'code-reviewer', T0 + 20 * MIN)), '別のブランチは数え直し');
  });
  test('git が受け付ける長めの日本語のブランチ名でも判定できる（状態のファイル名が長すぎて exit 2 にならない）', () => {
    // 仕様: ブランチごとに状態を持つ。日本語 30 字（90 バイトで git は作れる）が、バイトごとの %XX
    // 符号化で 270 文字を超え、ファイル名の上限 255 を越えて、そのブランチの全レビューが exit 2 で止まる
    const repo = makeRepo();
    const branch = `487-${'日'.repeat(30)}`;
    git(['switch', '-q', '-c', branch], repo);
    const r = call(repo, 'code-reviewer', T0);
    assert.equal(r.status, 0, r.stderr);
  });
  test('git が受け付ける長い ASCII のブランチ名（200 字）でも判定できる', () => {
    const repo = makeRepo();
    git(['switch', '-q', '-c', `487-${'a'.repeat(196)}`], repo);
    const r = call(repo, 'code-reviewer', T0);
    assert.equal(r.status, 0, r.stderr);
  });
  test('ブランチ名が ".json" や ".lock" で終わっても状態とロックが衝突しない', () => {
    const repo = makeRepo();
    git(['switch', '-q', '-c', 'x.json'], repo);
    assert.ok(isAllow(call(repo, 'code-reviewer', T0)));
    assert.ok(isAllow(call(repo, 'code-reviewer', T0 + 10 * MIN)));
    git(['switch', '-q', '-c', 'x', 'trunk'], repo);
    assert.ok(isAllow(call(repo, 'code-reviewer', T0)));
    assert.ok(isAllow(call(repo, 'code-reviewer', T0 + 10 * MIN)));
    assert.ok(isDeny(call(repo, 'code-reviewer', T0 + 20 * MIN)));
  });
  test('窓の境界を入口で確かめる（+120000 は同じ巡、+120001 は新しい巡で上限を超えると拒否）', () => {
    const repo = makeRepo();
    seed(repo, { starts: [T0, T0 + 10 * MIN], extra: 0 });
    assert.ok(isAllow(call(repo, 'code-reviewer', T0 + 10 * MIN + WINDOW_MS)));
    assert.ok(isDeny(call(repo, 'code-reviewer', T0 + 10 * MIN + WINDOW_MS + 1)));
  });
  test('REVIEW_BUDGET_NOW が数でないと exit 2（判定できない）', () => {
    const repo = makeRepo();
    const r = spawnSync(process.execPath, [script], {
      input: JSON.stringify({ cwd: repo, tool_input: { subagent_type: 'code-reviewer' } }),
      cwd: repo,
      encoding: 'utf8',
      env: { ...cleanEnv, REVIEW_BUDGET_NOW: 'abc' },
    });
    assert.equal(r.status, 2);
  });
  test('延長後に新しい巡の窓の中の起動は、上限ちょうどでも拒否されない', () => {
    const repo = makeRepo();
    assert.ok(isAllow(call(repo, 'code-reviewer', T0)));
    assert.ok(isAllow(call(repo, 'code-reviewer', T0 + 10 * MIN)));
    assert.ok(isDeny(call(repo, 'code-reviewer', T0 + 20 * MIN)));
    assert.equal(extend(repo, ['2', '--reason', 'r'], T0 + 21 * MIN).status, 0);
    assert.ok(isAllow(call(repo, 'code-reviewer', T0 + 22 * MIN)));
    assert.ok(isAllow(call(repo, 'security-reviewer', T0 + 22 * MIN + 1000)));
    assert.ok(isAllow(call(repo, 'code-reviewer', T0 + 40 * MIN)));
    assert.ok(isDeny(call(repo, 'code-reviewer', T0 + 60 * MIN)));
  });
  test('GIT_DIR が環境にあっても、cwd のブランチで数える（上限を素通りさせない）', () => {
    const repo = makeRepo();
    git(['switch', '-q', '-c', 'feat'], repo);
    const env = (now) => ({ ...envAt(now), GIT_DIR: path.join(tmp, 'nonexistent') });
    const run = (now) =>
      spawnSync(process.execPath, [script], { input: JSON.stringify({ tool_name: 'Agent', cwd: repo, tool_input: { subagent_type: 'code-reviewer', prompt: 'x' } }), cwd: repo, encoding: 'utf8', env: env(now) });
    assert.ok(isAllow(run(T0)));
    assert.ok(isAllow(run(T0 + 10 * MIN)));
    assert.ok(isDeny(run(T0 + 20 * MIN)));
  });
  test('extend は合計が安全な整数を超えるなら失敗し、状態を変えない', () => {
    const repo = makeRepo();
    assert.equal(extend(repo, ['9007199254740991', '--reason', 'a']).status, 0);
    assert.notEqual(extend(repo, ['9007199254740991', '--reason', 'b']).status, 0);
    assert.ok(isAllow(call(repo, 'code-reviewer', T0)), '状態が読めるまま');
  });
});

// ---- 崩す手口の追加（Issue #488: falsification-qa を巡に数える）----
describe('falsification-qa を数える（崩す手口、Issue #488）', () => {
  const repoRoot = path.resolve(hooks, '../..');
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'review-budget-fqa-')));
  after(() => rmSync(tmp, { recursive: true, force: true }));
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'REVIEW_BUDGET_NOW' && key !== 'CLAUDE_CODE_REMOTE'),
  );
  const git = (args, cwd) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      encoding: 'utf8',
      env: cleanEnv,
    });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  let n = 0;
  const makeRepo = () => {
    const dir = path.join(tmp, `r${++n}`);
    mkdirSync(dir);
    git(['init', '-q', '-b', 'trunk'], dir);
    git(['commit', '-q', '--allow-empty', '-m', 'init'], dir);
    return dir;
  };
  const MIN = 60_000;
  const envAt = (now) => ({ ...cleanEnv, REVIEW_BUDGET_NOW: String(now) });
  const inputOf = (cwd, agent) => JSON.stringify({ tool_name: 'Agent', cwd, tool_input: { subagent_type: agent, description: 'd', prompt: 'p' } });
  const call = (cwd, agent, now) => spawnSync(process.execPath, [script], { input: inputOf(cwd, agent), cwd, encoding: 'utf8', env: envAt(now) });
  const callAsync = (cwd, agent, now) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [script], { cwd, env: envAt(now) });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (status) => resolve({ agent, status, stdout, stderr }));
      child.stdin.end(inputOf(cwd, agent));
    });
  const stateFile = (repo) =>
    path.join(git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo), 'review-budget', `${rules.branchFileName('trunk')}.json`);
  const isDeny = (r) => r.status === 0 && r.stdout.includes('"deny"');
  const isAllow = (r) => r.status === 0 && r.stdout.trim() === '';
  // done-check と docs の「レビューのエージェント（`a`、`b`…）」の列挙を取り出す
  const listedAgents = (text, label) => {
    const m = text.match(new RegExp(`${label}（([^）]*)）`));
    assert.ok(m, `${label} の列挙が見つからない`);
    return [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]).sort();
  };
  const agentName = (file) => readFileSync(file, 'utf8').match(/^name:\s*(.+?)\s*$/m)?.[1];

  test('.claude/agents/ の定義のうち finding-verifier 以外はすべて数え、数える名前はすべて定義がある', () => {
    // フックは subagent_type の完全一致で数え、subagent_type は定義の name で決まる。ずれると素通りする
    const dir = path.join(repoRoot, '.claude/agents');
    const names = readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => agentName(path.join(dir, f)));
    assert.deepEqual(names.filter((x) => x !== 'finding-verifier').sort(), [...REVIEW_AGENTS].sort());
  });
  test('done-check と docs/development.md の対象の列挙が REVIEW_AGENTS と一致する', () => {
    const skill = readFileSync(path.join(repoRoot, '.claude/skills/done-check/SKILL.md'), 'utf8');
    const docs = readFileSync(path.join(repoRoot, 'docs/development.md'), 'utf8');
    assert.deepEqual(listedAgents(skill, 'レビューのエージェント'), [...REVIEW_AGENTS].sort());
    assert.deepEqual(listedAgents(docs, '`done-check` のレビューのエージェント'), [...REVIEW_AGENTS].sort());
  });
  test('既存の状態（延長の記録あり）に falsification-qa の新しい巡を足しても、extra と extensions を保つ', () => {
    const repo = makeRepo();
    const file = stateFile(repo);
    mkdirSync(path.dirname(file), { recursive: true });
    const ext = [{ rounds: 1, reason: '前の延長', at: T0 - MIN }];
    writeFileSync(file, JSON.stringify({ starts: [T0, T0 + 10 * MIN], extra: 1, extensions: ext }));
    assert.ok(isAllow(call(repo, 'falsification-qa', T0 + 20 * MIN)));
    const s = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(s.starts, [T0, T0 + 10 * MIN, T0 + 20 * MIN]);
    assert.equal(s.extra, 1);
    assert.deepEqual(s.extensions, ext);
    assert.ok(isDeny(call(repo, 'falsification-qa', T0 + 30 * MIN)), '延長の分を使い切った後は拒否');
  });
  test('done-check の同時起動（4 体 + falsification-qa + finding-verifier + Explore）は 1 巡に数える', async () => {
    const repo = makeRepo();
    // falsification-qa に巡を開かせる。ほかの4体が先だと、falsification-qa を数えなくても starts は1件になる
    assert.ok(isAllow(call(repo, 'falsification-qa', T0)));
    const agents = ['code-reviewer', 'security-reviewer', 'database-reviewer', 'ui-reviewer', 'finding-verifier', 'Explore'];
    const results = await Promise.all(agents.map((a, i) => callAsync(repo, a, T0 + 1 + i)));
    for (const r of results) assert.ok(isAllow(r), `${r.agent}: ${r.status} ${r.stdout} ${r.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(stateFile(repo), 'utf8')).starts, [T0]);
  });
  test('上限に達した後の同時起動では、falsification-qa とレビューは拒否し、finding-verifier と Explore は通す', async () => {
    const repo = makeRepo();
    assert.ok(isAllow(call(repo, 'falsification-qa', T0)));
    assert.ok(isAllow(call(repo, 'code-reviewer', T0 + 10 * MIN)));
    const before = readFileSync(stateFile(repo), 'utf8');
    const results = await Promise.all(['falsification-qa', 'code-reviewer', 'finding-verifier', 'Explore'].map((a) => callAsync(repo, a, T0 + 20 * MIN)));
    const by = Object.fromEntries(results.map((r) => [r.agent, r]));
    assert.ok(isDeny(by['falsification-qa']), by['falsification-qa'].stdout);
    assert.ok(isDeny(by['code-reviewer']));
    assert.ok(isAllow(by['finding-verifier']));
    assert.ok(isAllow(by.Explore));
    assert.equal(readFileSync(stateFile(repo), 'utf8'), before);
  });
});
