// PreToolUse（Bash、Monitor、PowerShell）の入口。判定は bash-rules.mjs。
// import されない前提で、起動されたら必ず判定する（シンボリックリンク経由で起動されても素通りしない）。
// 判定できないときは exit 2 で止める（onFailure を読まない古い Claude Code でも止まるように）。
// 判定のモジュールは try の中で読み込む。静的に import すると、読み込みの失敗が exit 1（素通り）になる。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// --abbrev-ref と symbolic-ref --short は、同名のタグがあると heads/main を返すので、完全な ref から名前を取る。
// detached HEAD とブランチを引けないときは undefined（push の先を判定できないものとして確認を挟む）
function branchOf(dir) {
  try {
    const ref = execFileSync('git', ['-C', dir, 'symbolic-ref', '--quiet', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return ref.replace(/^refs\/heads\//, '');
  } catch {
    return undefined;
  }
}

function scriptOf(dir, name) {
  if (!dir) return undefined;
  for (let d = dir; ; d = path.dirname(d)) {
    const file = path.join(d, 'package.json');
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')).scripts?.[name];
    if (d === path.dirname(d)) return undefined;
  }
}

try {
  const { judgeBash } = await import('./bash-rules.mjs');
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const command = input.tool_input?.command;
  if (typeof command === 'string') {
    const verdict = judgeBash(command, { cwd: input.cwd ?? process.cwd(), branchOf, scriptOf });
    if (verdict) {
      const [decision, reason] = verdict;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision,
            permissionDecisionReason: `${reason}（.claude/hooks/bash-rules.mjs）`,
          },
        }),
      );
    }
  }
} catch (error) {
  process.stderr.write(`guard-bash: 判定できなかったので止めました: ${error.message}\n`);
  process.exit(2);
}
