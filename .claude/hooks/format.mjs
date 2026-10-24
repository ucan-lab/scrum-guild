// PostToolUse（Write、Edit、MultiEdit）。書いたファイルを Prettier で整え、差分の揺れを消す。
// このリポジトリ（とその下のワークツリー）のファイルだけを整える。外のリポジトリの prettier と設定は動かさない。
// 依存がまだ入っていない作業コピーでは何もしない。整形できないファイルは CI の format:check に任せる。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8'));
const filePath = input.tool_input?.file_path;
const projectDir = process.env.CLAUDE_PROJECT_DIR && realpathSync(process.env.CLAUDE_PROJECT_DIR);

if (filePath && projectDir) {
  const absolute = path.resolve(input.cwd ?? process.cwd(), filePath);
  const root = spawnSync('git', ['-C', path.dirname(absolute), 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).stdout?.trim();
  const inProject = root && (root === projectDir || root.startsWith(`${projectDir}/worktrees/`));
  const prettier = inProject && path.join(root, 'node_modules', '.bin', 'prettier');
  if (prettier && existsSync(prettier)) {
    spawnSync(prettier, ['--write', '--ignore-unknown', '--log-level', 'warn', absolute], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  }
}
