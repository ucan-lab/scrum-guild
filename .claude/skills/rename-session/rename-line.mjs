// rename-session の名前の組み立て。Issue の題は外の人が書き換えられるので、モデルに書き写させず、ここで組む。
//   node .claude/skills/rename-session/rename-line.mjs [--issue <番号>] [--pr <番号>] [--copy]
// 標準出力は `/rename <名前>` の1行。`--copy` を付けると、同じ行を pbcopy でクリップボードに入れる。
// 引けなかった値と pbcopy の失敗は、標準エラーに理由を出して終了コード 1 で終わる。
import { execFileSync, spawnSync } from 'node:child_process';
import { titleFor } from '../../hooks/session-title-rules.mjs';

// 値の無いフラグ、重複、未知の引数は失敗にする（黙って無視すると、PR の後なのに PR の前の名前をクリップボードに入れる）
function parseArgs(argv) {
  const parsed = { copy: false };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (arg === '--copy') {
      parsed.copy = true;
    } else if (arg === '--issue' || arg === '--pr') {
      const value = argv[at + 1];
      if (value === undefined || value.startsWith('--')) fail(`${arg} に値がありません`);
      if (!/^[1-9]\d{0,8}$/.test(value)) fail(`${arg} は正の整数で渡してください: ${value}`);
      if (parsed[arg] !== undefined) fail(`${arg} が2回渡されています`);
      parsed[arg] = Number(value);
      at += 1;
    } else {
      fail(`未知の引数です: ${arg}`);
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const gh = (...ghArgs) => execFileSync('gh', ghArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim();

const issueNumber = args['--issue'];
const prNumber = args['--pr'];
if (issueNumber === undefined && prNumber === undefined) fail('--issue か --pr のどちらかが要ります');

let issueTitle;
let pr;
try {
  // クラウドのセッションは GraphQL（gh issue view、gh pr view）が 403 になるので、REST の gh api で引く。{owner}/{repo} は gh api が置き換える
  if (issueNumber !== undefined) issueTitle = gh('api', `repos/{owner}/{repo}/issues/${issueNumber}`, '--jq', '.title');
  if (prNumber !== undefined) pr = { number: prNumber, title: issueNumber === undefined ? gh('api', `repos/{owner}/{repo}/pulls/${prNumber}`, '--jq', '.title') : '' };
} catch {
  fail('gh で Issue か PR の題を引けませんでした');
}

const name = titleFor({ issueNumber, issueTitle, pr });
if (!name) fail('名前を組み立てられませんでした');

const line = `/rename ${name}`;
process.stdout.write(`${line}\n`);

if (args.copy) {
  const copied = spawnSync('pbcopy', { input: line, encoding: 'utf8' });
  if (copied.error || copied.status !== 0) fail('pbcopy でクリップボードに入れられませんでした。上の行を手で貼ってください');
}
