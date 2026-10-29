// PreToolUse（Agent）の入口。判定は review-budget-rules.mjs。
// `node .claude/hooks/review-budget.mjs extend <巡数> --reason <理由>` で上限を延ばす。
// import されない前提で、起動されたら必ず判定する。判定できないときは exit 2 で止める。
// 判定のモジュールは try の中で読み込む。静的に import すると、読み込みの失敗が exit 1（素通り）になる。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const git = (dir, args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// ブランチ名。detached HEAD、git の外、ブランチを引けないときは undefined
function branchOf(dir) {
  try {
    return git(dir, ['symbolic-ref', '--quiet', 'HEAD']).replace(/^refs\/heads\//, '') || undefined;
  } catch {
    return undefined;
  }
}

function commonDirOf(dir) {
  return git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
}

function nowMs() {
  const env = process.env.REVIEW_BUDGET_NOW;
  if (env === undefined || env === '') return Date.now();
  const n = Number(env);
  if (!Number.isFinite(n)) throw new Error(`REVIEW_BUDGET_NOW が数ではありません: ${env}`);
  return n;
}

const LOCK_TIMEOUT_MS = 10000;
const LOCK_STALE_MS = 30000;

// mkdir のロックで直列にして fn を実行し、ロックは必ず消す
async function withLock(lockDir, fn) {
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // 他のプロセスが消した。もう一度取りにいく
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error('ロックを取れませんでした');
      await sleep(10);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

// 状態を読み、update(state) の戻りが変わっていれば書く。壊れた状態は throw する（許可に倒さない）
async function updateState(dir, branch, rules, update) {
  const base = path.join(dir, rules.branchFileName(branch));
  const file = `${base}.json`;
  mkdirSync(dir, { recursive: true });
  return withLock(`${base}.lock`, () => {
    let state;
    try {
      state = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`状態ファイルを読めません（${file}）: ${error.message}`);
      state = rules.emptyState();
    }
    if (!state || !Array.isArray(state.starts) || !state.starts.every((s) => Number.isFinite(s)) || !Number.isSafeInteger(state.extra) || state.extra < 0) {
      throw new Error(`状態ファイルの形が不正です（${file}）`);
    }
    const result = update(state);
    if (result.state !== state) {
      const tmp = `${base}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(result.state, null, 2)}\n`);
      renameSync(tmp, file);
    }
    return result;
  });
}

async function extend(args, rules) {
  const [rounds, flag, reason, ...rest] = args;
  if (!/^[1-9]\d*$/.test(rounds ?? '') || !Number.isSafeInteger(Number(rounds))) throw new Error('巡数は正の整数で渡してください');
  if (flag !== '--reason' || rest.length > 0 || typeof reason !== 'string' || reason.trim() === '') {
    throw new Error('使い方: extend <巡数> --reason <理由>（理由は空にできません）');
  }
  const cwd = process.cwd();
  const branch = branchOf(cwd);
  if (!branch) throw new Error('ブランチを引けません（detached HEAD か git の外）');
  const now = nowMs();
  await updateState(path.join(commonDirOf(cwd), 'review-budget'), branch, rules, (state) => ({
    state: rules.extendState(state, Number(rounds), reason.trim(), now),
  }));
}

async function hook(rules) {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('入力が object ではありません');
  const agentType = input.tool_input?.subagent_type;
  if (typeof agentType !== 'string' || !rules.REVIEW_AGENTS.includes(agentType)) return;
  const cwd = input.cwd ?? process.cwd();
  const branch = branchOf(cwd);
  if (!branch) return; // ブランチを引けないときは拒否せず数えない
  const now = nowMs();
  const result = await updateState(path.join(commonDirOf(cwd), 'review-budget'), branch, rules, (state) =>
    rules.judgeReview(state, agentType, now),
  );
  if (result.decision === 'deny') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `${result.reason}（.claude/hooks/review-budget-rules.mjs）`,
        },
      }),
    );
  }
}

const isExtend = process.argv[2] === 'extend';
try {
  const rules = await import('./review-budget-rules.mjs');
  if (isExtend) await extend(process.argv.slice(3), rules);
  else await hook(rules);
} catch (error) {
  process.stderr.write(`review-budget: ${isExtend ? '延長できませんでした' : '判定できなかったので止めました'}: ${error.message}\n`);
  process.exit(isExtend ? 1 : 2);
}
