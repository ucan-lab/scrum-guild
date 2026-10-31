// SessionStart。ワークツリーのブランチ名の Issue 番号から、セッション名を付ける。
//   PR が無い:  #<Issue番号> <Issueの題>
//   PR がある:  #<Issue番号> PR #<PR番号> <Issueの題>
// 名前は開始・再開のときにしか付けられない（実行中に変える経路はない）。
// Issue の無いブランチに PR だけある形（`PR #<PR番号> <PRのタイトル>`）は付けない。rename-session が付ける。
// 付けられないときは何も出さずに終わる。セッションを止めない。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { issueNumberOf, pickPr, titleFor } from './session-title-rules.mjs';

// GIT_DIR などを受け継ぐと、-C で指した先と別のリポジトリを引く
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, ...options }).trim();

// PR の取得に失敗しても、Issue の題だけで名前を付ける
function prOf(branch, cwd) {
  try {
    const json = run('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '10', '--json', 'number,state'], { cwd });
    return pickPr(JSON.parse(json || '[]'));
  } catch {
    return undefined;
  }
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  // --name や /rename で付けた名前を上書きしない
  if (input.session_title) return;

  const cwd = input.cwd || process.cwd();
  const branch = run('git', ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
  const issueNumber = issueNumberOf(branch);
  if (issueNumber === undefined) return;

  const issueTitle = run('gh', ['issue', 'view', String(issueNumber), '--json', 'title', '--jq', '.title'], { cwd });
  if (!issueTitle) return;

  const sessionTitle = titleFor({ issueNumber, issueTitle, pr: prOf(branch, cwd) });
  if (!sessionTitle) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle } }));
}

try {
  main();
} catch {
  // git の外、gh が使えない、Issue が無い、のどれでも名前なしで始める
}
