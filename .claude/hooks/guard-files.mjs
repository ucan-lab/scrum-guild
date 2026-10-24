// PreToolUse（Write、Edit、MultiEdit）の入口。判定は file-rules.mjs。
// import されない前提で、起動されたら必ず判定する。判定できないときは exit 2 で止める。
// 判定のモジュールは try の中で読み込む。静的に import すると、読み込みの失敗が exit 1（素通り）になる。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

function writtenContents(toolName, toolInput) {
  if (toolName === 'Write') return toolInput.content ?? '';
  if (toolName === 'MultiEdit') return (toolInput.edits ?? []).map((e) => e.new_string ?? '').join('\n');
  return toolInput.new_string ?? '';
}

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

// 新しく作るファイルはまだ無いので、あるところまで親をさかのぼる。
// git はシンボリックリンクを解いたパスを返すので、こちらも解いてから相対パスにする
function locate(filePath) {
  let dir = path.dirname(filePath);
  while (!existsSync(dir) && dir !== path.dirname(dir)) dir = path.dirname(dir);
  let root;
  try {
    root = git(dir, ['rev-parse', '--show-toplevel']);
  } catch {
    return undefined;
  }
  const real = path.join(realpathSync(dir), path.relative(dir, filePath));
  return { root, rel: path.relative(root, real).split(path.sep).join('/'), inWorktree: isLinkedWorktree(dir) };
}

// リンクされたワークツリーでは、作業コピーの .git と共有の .git が別になる。判定できなければ本体とみなす
function isLinkedWorktree(dir) {
  try {
    const [gitDir, commonDir] = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']).split('\n');
    return gitDir !== commonDir;
  } catch {
    return false;
  }
}

// origin/main か main にあれば true、どちらの ref も引けなければ undefined
function existsOnMain(root, rel) {
  const refs = ['origin/main', 'main'].filter((ref) => {
    try {
      git(root, ['rev-parse', '--verify', '--quiet', ref]);
      return true;
    } catch {
      return false;
    }
  });
  if (refs.length === 0) return undefined;
  return refs.some((ref) => {
    try {
      git(root, ['cat-file', '-e', `${ref}:${rel}`]);
      return true;
    } catch {
      return false;
    }
  });
}

try {
  const { judgeFile } = await import('./file-rules.mjs');
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const filePath = input.tool_input?.file_path;
  const located = filePath && locate(path.resolve(input.cwd ?? process.cwd(), filePath));
  if (located && !located.rel.startsWith('..')) {
    const { root, rel, inWorktree } = located;
    const verdict = judgeFile({
      rel,
      inWorktree,
      contents: writtenContents(input.tool_name, input.tool_input),
      shippedOnMain: rel.startsWith('migrations/') ? existsOnMain(root, rel) : false,
    });
    if (verdict) {
      const [decision, reason] = verdict;
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision,
            permissionDecisionReason: `${reason}（.claude/hooks/file-rules.mjs）`,
          },
        }),
      );
    }
  }
} catch (error) {
  process.stderr.write(`guard-files: 判定できなかったので止めました: ${error.message}\n`);
  process.exit(2);
}
