#!/usr/bin/env bash
# SessionStart。クラウドのセッションは毎回まっさらな環境で始まるので、依存を入れる。
# 手元のセッションは各自のワークツリーで入れる（docs/development.md の「ワークツリーで作業する」）。
# 失敗してもセッションは止めず、理由を標準出力に出して Claude に伝える。
set -u

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
[ -f package.json ] || exit 0

if ! command -v pnpm >/dev/null 2>&1; then
  if ! corepack enable >/dev/null 2>&1; then
    echo "依存を入れていません: corepack enable が失敗し、pnpm を用意できませんでした"
    exit 0
  fi
fi

if ! out=$(pnpm install --frozen-lockfile 2>&1); then
  echo "依存を入れていません: pnpm install --frozen-lockfile が失敗しました"
  # .npmrc の認証の値や、URL に埋めた user:pass が出力に混ざっても Claude に渡さない
  echo "$out" | tail -n 20 | grep -viE 'token|auth|password|secret' | sed -E 's#://[^/@[:space:]]+@#://***@#g'
fi
exit 0
