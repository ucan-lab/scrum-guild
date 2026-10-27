#!/usr/bin/env bash
# SessionStart。クラウドのセッションは毎回まっさらな環境で始まるので、依存を入れる。
# 手元のセッションは各自のワークツリーで入れる（docs/development.md の「ワークツリーで作業する」）。
# 失敗してもセッションは止めず、理由を標準出力に出して Claude に伝える。
set -u

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
[ -f package.json ] || exit 0

# セットアップスクリプトが /opt/node<主版> に入れた Node を、セッションの Bash で選ばせる。
# セッションの Bash は初期化ファイルを読まないので、Claude Code が各コマンドの前に読む CLAUDE_ENV_FILE に書く。
# このフック自身は VM の既定の Node で動かす（docs/development.md の「クラウド環境」）
node_major=$(sed -nE '1s/^v?([0-9]+)(\..*)?[[:space:]]*$/\1/p' .node-version 2>/dev/null)
if [ -z "$node_major" ]; then
  echo "Node を選ばせていません: .node-version から主版を読めませんでした"
elif [ ! -x "/opt/node${node_major}/bin/node" ]; then
  # .node-version を上げた後に、環境のセットアップスクリプトが走り直していないとき
  echo "Node ${node_major} を選ばせていません: /opt/node${node_major} がありません。環境のセットアップスクリプトを貼り直してください"
elif [ -z "${CLAUDE_ENV_FILE:-}" ]; then
  echo "Node ${node_major} を選ばせていません: CLAUDE_ENV_FILE が渡されていません"
else
  line="export PATH=\"/opt/node${node_major}/bin:\$PATH\""
  # 再開でも走るので、同じ行を重ねない
  if ! grep -qxF "$line" "$CLAUDE_ENV_FILE" 2>/dev/null && ! echo "$line" 2>/dev/null >>"$CLAUDE_ENV_FILE"; then
    echo "Node ${node_major} を選ばせていません: CLAUDE_ENV_FILE に書けませんでした"
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if ! { command -v corepack >/dev/null 2>&1 && corepack enable >/dev/null 2>&1; }; then
    # Node 25 からは corepack が同梱されない。package.json の packageManager の版を npm で入れる
    # 版の形（x.y.z）だけを通す。npm の別名（pnpm@npm:<別のパッケージ>）などを入れないため
    version=$(node -p "(require('./package.json').packageManager ?? '').replace(/^pnpm@/, '').split('+')[0]" 2>/dev/null)
    if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "依存を入れていません: corepack が無く、package.json の packageManager から pnpm の版を読めませんでした"
      exit 0
    fi
    if ! npm install -g "pnpm@${version}" >/dev/null 2>&1; then
      echo "依存を入れていません: corepack が無く、npm install -g pnpm@${version} でも pnpm を用意できませんでした"
      exit 0
    fi
  fi
fi

if ! out=$(pnpm install --frozen-lockfile 2>&1); then
  echo "依存を入れていません: pnpm install --frozen-lockfile が失敗しました"
  # .npmrc の認証の値や、URL に埋めた user:pass が出力に混ざっても Claude に渡さない
  echo "$out" | tail -n 20 | grep -viE 'token|auth|password|secret' | sed -E 's#://[^/@[:space:]]+@#://***@#g'
fi
exit 0
