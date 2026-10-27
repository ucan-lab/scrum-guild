import { join, sep } from 'node:path';

// vite dev が監視しない根のフォルダ。並べたワークツリー、e2e の報告、build の書き出しの .html の変更で、
// 開いている画面を読み直させない（#367。test-results/ は vite がはじめから外す）
const UNWATCHED = ['worktrees', 'playwright-report', 'build'];

// server.watch.ignored に渡す述語。glob にすると、根のパスの ( ) [ ] { } などを記号と読んで一致しなくなるので、
// パスの前方一致で判定する。根からの絶対パスで比べ、src/ の下の同じ名前を巻き込まない
export function devWatchIgnored(root: string): (file: string) => boolean {
  const dirs = UNWATCHED.map((dir) => join(root, dir));
  return (file) => dirs.some((dir) => file === dir || file.startsWith(dir + sep));
}
