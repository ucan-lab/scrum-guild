// Write と Edit の判定。CLAUDE.md の「守ること」のうち、書いた内容で判定できるものを止め、
// 守る仕組みそのもの（.claude/settings*.json と、セッションが使っている .claude/hooks/）の書き換えには人の確認を挟む。
// D1 の binding の判定は、ESLint の入口を守る規則（docs/development.md の「入口を守る規則」）が入るまでのつなぎ。
import path from 'node:path';

// rel はリポジトリのルートからの相対パス。shippedOnMain は origin/main に同じパスがあるか（main を引けなければ undefined）
// inWorktree は、セッションが使うフックのあるリポジトリとは別の、リンクされたワークツリーの中のファイルか
// onMain は、ファイルのある作業コピーが main にいるか（本体の detached も含む）。ほかのどの判定より先に止める
// 一番重い判定を [決定, 理由] で返す。止めるものが無ければ null
export function judgeFile({ rel, contents, shippedOnMain, inWorktree = false, onMain = false }) {
  const name = path.basename(rel);

  // 文書も含めて、変更はすべて作業ブランチで作り PR を通す。main の作業コピーは読むだけにする
  if (onMain) {
    return ['deny', 'main の作業コピーは書き換えない。git fetch origin のあと git worktree add worktrees/<Issue番号>-<名前> -b <同じ名前> origin/main でワークツリーを切り、その中で書く（docs/development.md の「ワークツリーで作業する」）'];
  }

  // 設定は disableAllHooks でフックごと切れるので、どこでも確かめる
  if (/^\.claude\/settings[^/]*\.json$/.test(rel)) {
    return ['ask', '守る仕組み（Claude の設定）の変更は人が確かめる'];
  }
  // セッションが使うのは $CLAUDE_PROJECT_DIR のフック。別のワークツリーでの書き換えは PR で人が読むまで効かない
  if (rel.startsWith('.claude/hooks/') && !inWorktree) {
    return ['ask', '守る仕組み（フック）の変更は人が確かめる。ワークツリーで書き換えて PR を通す'];
  }
  if (rel.startsWith('migrations/') && shippedOnMain) {
    return ['deny', 'マイグレーションは足すだけにし、main にあるファイルを書き換えない。直すときは新しい番号のファイルを足す'];
  }
  if (rel.startsWith('migrations/') && shippedOnMain === undefined) {
    return ['ask', 'main を引けず、このマイグレーションが既に main にあるかを判定できない'];
  }
  if (/^\+(page|layout)\.server\.[jt]s$|^\+server\.[jt]s$|^hooks\.server\.[jt]s$/.test(name)) {
    return ['deny', '画面は SPA として作る。データは Hono の API から取り、+page.server、+layout.server、+server、hooks.server は使わない'];
  }
  if (
    rel.startsWith('src/') &&
    !rel.startsWith('src/server/db/') &&
    /\benv\.DB\b|\bD1Database\b/.test(contents)
  ) {
    return ['deny', 'D1 には src/server/db/ の Kysely の入口からだけ問い合わせる。binding の型は wrangler types の Env を使う'];
  }
  if (name.endsWith('.svelte') && /<style[\s>]/i.test(contents)) {
    return ['deny', '画面ごとの CSS を持たない。足りない部品は先にデザインシステム（tokens.css、components.css）へ足す'];
  }
  if (/^wrangler[^/]*\.(json|jsonc|toml)$/.test(name) && /"remote"\s*:\s*true|\bremote\s*=\s*true/.test(contents)) {
    return ['deny', 'remote を有効にした binding は、wrangler dev から本番の D1 と R2 に届く'];
  }
  return null;
}
