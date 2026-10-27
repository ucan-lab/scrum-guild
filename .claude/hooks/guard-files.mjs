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

// GIT_DIR などを受け継ぐと、-C で指した先と別のリポジトリを判定してしまう
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: gitEnv,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

// 新しく作るファイルはまだ無いので、あるところまで親をさかのぼる。
// git はシンボリックリンクを解いたパスを返すので、こちらも解いてから相対パスにする。
// 既にあるファイルはファイル自体のリンクも解く（ワークツリーのリンクから本体のフックを書き換えさせない）
function locate(filePath) {
  const target = existsSync(filePath) ? realpathSync(filePath) : filePath;
  let dir = path.dirname(target);
  while (!existsSync(dir) && dir !== path.dirname(dir)) dir = path.dirname(dir);
  let root;
  try {
    root = git(dir, ['rev-parse', '--show-toplevel']);
  } catch {
    return undefined;
  }
  const real = path.join(realpathSync(dir), path.relative(dir, target));
  return { root, rel: path.relative(root, real).split(path.sep).join('/'), dir };
}

// リンクされたワークツリーでは、作業コピーの .git と共有の .git が別になる。
// 古い git は知らないオプションを出力に混ぜて成功するので、2行とも読めたときだけ比べ、判定できなければ本体とみなす
function isLinkedWorktree(dir) {
  try {
    const lines = git(dir, ['rev-parse', '--absolute-git-dir', '--git-common-dir']).split('\n');
    if (lines.length !== 2 || !path.isAbsolute(lines[0]) || !lines[1] || lines[1].startsWith('-')) return false;
    return realpathSync(lines[0]) !== realpathSync(path.resolve(dir, lines[1]));
  } catch {
    return false;
  }
}

// フックの書き換えに確認を挟まないのは、セッションが使うフック（$CLAUDE_PROJECT_DIR）とは別のワークツリーだけ。
// ワークツリーで起動したセッションが、自分を縛るフックを外せないようにする。プロジェクトを引けなければ確認を挟む
function isOtherWorktree(root, dir) {
  const project = process.env.CLAUDE_PROJECT_DIR;
  if (!project || !isLinkedWorktree(dir)) return false;
  try {
    return realpathSync(git(project, ['rev-parse', '--show-toplevel'])) !== realpathSync(root);
  } catch {
    return false;
  }
}

const commonDir = (dir) => realpathSync(path.resolve(dir, git(dir, ['rev-parse', '--git-common-dir'])));

// セッションのリポジトリ（本体と、そのワークツリー）か。別のリポジトリのファイルは見ない。
// プロジェクトを引けないとき（変数が無い、ワークツリーを消した後のセッション）は、同じリポジトリとみなして止める側に倒す
function isProjectRepo(root) {
  const project = process.env.CLAUDE_PROJECT_DIR;
  let projectCommon;
  try {
    projectCommon = project && commonDir(project);
  } catch {
    projectCommon = undefined;
  }
  return !projectCommon || commonDir(root) === projectCommon;
}

// 作業コピーが main にいるか。--abbrev-ref は同名のタグがあると heads/main を返すので、symbolic-ref で見る。
// 本体の作業コピーを detached にして抜けさせない。rebase の途中のワークツリーと、本体で rebase するクラウドのセッションは通す
function isProjectOnMain(root, dir) {
  try {
    if (!isProjectRepo(root)) return false;
    let ref;
    try {
      ref = git(root, ['symbolic-ref', '--quiet', 'HEAD']);
    } catch {
      return !isLinkedWorktree(dir) && process.env.CLAUDE_CODE_REMOTE !== 'true';
    }
    return ref === 'refs/heads/main';
  } catch {
    // git のリポジトリの中なのに判定できないときは、止める側に倒す
    return true;
  }
}

// origin/main か main にあれば true、どちらの ref も引けなければ undefined。
// 大文字小文字を崩した名前（Migrations/0001_x.sql）は、macOS では main にあるファイルを指すので、同じ名前を小文字で比べても探す。
// git ls-tree のパスは大文字小文字を区別するので、根から migrations の名前のディレクトリを探し、その下を並べて比べる。
// 比べられなければ undefined（確認を挟む）
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
  const folded = rel.toLowerCase();
  const directory = folded.split('/')[0];
  let unknown = false;
  for (const ref of refs) {
    try {
      git(root, ['cat-file', '-e', `${ref}:${rel}`]);
      return true;
    } catch {
      // 同じ名前が無いだけなら、下の大文字小文字を崩した照合に進む
    }
    try {
      const directories = git(root, ['ls-tree', '--name-only', ref]).split('\n').filter((name) => name.toLowerCase() === directory);
      for (const name of directories) {
        const files = git(root, ['ls-tree', '-r', '--name-only', ref, '--', `${name}/`]).split('\n');
        if (files.some((file) => file.toLowerCase() === folded)) return true;
      }
    } catch {
      unknown = true;
    }
  }
  return unknown ? undefined : false;
}

// 守る先は大文字小文字を区別せずに見る（file-rules.mjs と同じ）
const startsWithFolded = (rel, prefix) => rel.toLowerCase().startsWith(prefix);

try {
  const { judgeFile } = await import('./file-rules.mjs');
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const filePath = input.tool_input?.file_path;
  const located = filePath && locate(path.resolve(input.cwd ?? process.cwd(), filePath));
  if (located && !located.rel.startsWith('..')) {
    const { root, rel, dir } = located;
    const verdict = judgeFile({
      rel,
      onMain: isProjectOnMain(root, dir),
      inWorktree: (startsWithFolded(rel, '.claude/hooks/') || startsWithFolded(rel, '.githooks/')) && isOtherWorktree(root, dir),
      contents: writtenContents(input.tool_name, input.tool_input),
      shippedOnMain: startsWithFolded(rel, 'migrations/') ? existsOnMain(root, rel) : false,
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
