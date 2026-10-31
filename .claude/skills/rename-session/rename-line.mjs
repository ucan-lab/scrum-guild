// rename-session の名前の組み立て。Issue の題は外の人が書き換えられるので、モデルに書き写させず、ここで組む。
//   node .claude/skills/rename-session/rename-line.mjs [--issue <番号>] [--pr <番号>] [--copy]
// 標準出力は `/rename <名前>` の1行。`--copy` を付けると、同じ行を pbcopy でクリップボードに入れる。
// 引けなかった値と pbcopy の失敗は、標準エラーに理由を出して終了コード 1 で終わる。
import { execFileSync, spawnSync } from 'node:child_process';
import { titleFor } from '../../hooks/session-title-rules.mjs';

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};
const numberOf = (flag) => {
  const value = valueOf(flag);
  if (value === undefined) return undefined;
  if (!/^[1-9]\d{0,8}$/.test(value)) fail(`${flag} は正の整数で渡してください: ${value}`);
  return Number(value);
};

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const gh = (...ghArgs) => execFileSync('gh', ghArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim();

const issueNumber = numberOf('--issue');
const prNumber = numberOf('--pr');
if (issueNumber === undefined && prNumber === undefined) fail('--issue か --pr のどちらかが要ります');

let issueTitle;
let pr;
try {
  if (issueNumber !== undefined) issueTitle = gh('issue', 'view', String(issueNumber), '--json', 'title', '--jq', '.title');
  if (prNumber !== undefined) pr = { number: prNumber, title: issueNumber === undefined ? gh('pr', 'view', String(prNumber), '--json', 'title', '--jq', '.title') : '' };
} catch {
  fail('gh で Issue か PR の題を引けませんでした');
}

const name = titleFor({ issueNumber, issueTitle, pr });
if (!name) fail('名前を組み立てられませんでした');

const line = `/rename ${name}`;
process.stdout.write(`${line}\n`);

if (args.includes('--copy')) {
  const copied = spawnSync('pbcopy', { input: line, encoding: 'utf8' });
  if (copied.error || copied.status !== 0) fail('pbcopy でクリップボードに入れられませんでした。上の行を手で貼ってください');
}
