#!/bin/bash
# クラウド環境のセットアップスクリプト。中身をクラウド環境の設定に貼って使う（docs/development.md の「クラウド環境」）。
# VM の用意だけを受け持つ（Node、pnpm、pnpm のストア、Playwright の chromium）。依存の導入は毎回 session-start.sh が行い、
# ここで温めたストアから組む。終了コードが 0 以外だとセッションが始まらないので、どの段の失敗も警告にとどめて先へ進む。
set -u

warn() { echo "[cloud-setup] 警告: $*" >&2; }
info() { echo "[cloud-setup] $*"; }

# 走る時点の clone の置き場所は文書に書かれていないので、いくつかの場所を見る
repo=""
for dir in "$PWD" /home/user/scrum-guild /root/scrum-guild /workspace/scrum-guild; do
  if [ -f "$dir/package.json" ] && grep -q '"name": "scrum-guild"' "$dir/package.json"; then
    repo="$dir"
    break
  fi
done
if [ -z "$repo" ]; then
  found=$(find /home /root /workspace -maxdepth 3 -name package.json -path '*scrum-guild*' 2>/dev/null | head -n 1)
  [ -n "$found" ] && repo=$(dirname "$found")
fi
if [ -n "$repo" ]; then
  info "リポジトリ: $repo"
else
  warn "リポジトリが見つからないので、版は既定の値を使い、ストアと chromium は用意しない"
fi

# 版はリポジトリから読み、読めなければ既定の値にする
node_major=26
pnpm_version=12.12.0
if [ -n "$repo" ]; then
  v=$(tr -d '[:space:]v' < "$repo/.node-version" 2>/dev/null)
  [[ "$v" =~ ^[0-9]+$ ]] && node_major="$v"
  v=$(sed -nE 's/.*"packageManager": "pnpm@([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' "$repo/package.json")
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && pnpm_version="$v"
fi

# VM の既定は Node 22。nodejs.org から .node-version の版の最新を入れ、チェックサムを確かめる
install_node() {
  local base="https://nodejs.org/dist/latest-v${node_major}.x"
  local tmp sums file
  tmp=$(mktemp -d)
  sums=$(curl -fsSL "$base/SHASUMS256.txt") || { warn "Node ${node_major} の SHASUMS256.txt を取れない"; return 1; }
  file=$(echo "$sums" | awk '{print $2}' | grep -E '^node-v[0-9.]+-linux-x64\.tar\.xz$' | head -n 1)
  [ -n "$file" ] || { warn "Node ${node_major} の linux-x64 の配布が見つからない"; return 1; }
  curl -fsSL -o "$tmp/$file" "$base/$file" || { warn "$file を取れない"; return 1; }
  (cd "$tmp" && echo "$sums" | grep " $file\$" | sha256sum -c --status) || { warn "$file のチェックサムが合わない"; return 1; }
  rm -rf "/opt/node${node_major}"
  mkdir -p "/opt/node${node_major}"
  tar -xJf "$tmp/$file" -C "/opt/node${node_major}" --strip-components=1 || return 1
  rm -rf "$tmp"
  # PATH で /opt/node22/bin より先に見つかるよう /usr/local/bin に置く
  for bin in node npm npx corepack; do
    [ -e "/opt/node${node_major}/bin/$bin" ] && ln -sf "/opt/node${node_major}/bin/$bin" "/usr/local/bin/$bin"
  done
  hash -r
}
install_node || warn "Node ${node_major} を入れられなかった。VM の既定の Node で続ける"
info "node: $(command -v node) $(node --version 2>/dev/null)"

# Node 25 からは corepack が同梱されないので、packageManager の版を npm で入れる
if npm install -g "pnpm@${pnpm_version}" >/dev/null 2>&1; then
  ln -sf "$(npm prefix -g)/bin/pnpm" /usr/local/bin/pnpm
  ln -sf "$(npm prefix -g)/bin/pnpx" /usr/local/bin/pnpx 2>/dev/null
  hash -r
else
  warn "pnpm@${pnpm_version} を入れられなかった"
fi
info "pnpm: $(command -v pnpm) $(pnpm --version 2>/dev/null)"

[ -n "$repo" ] || exit 0
cd "$repo" || exit 0

# ストアはリポジトリの外にあり、スナップショットに残る
if ! pnpm install --frozen-lockfile >/tmp/cloud-setup-pnpm.log 2>&1; then
  warn "pnpm install が失敗した（/tmp/cloud-setup-pnpm.log の末尾）"
  # .npmrc の認証の値や、URL に埋めた user:pass が出力に混ざっても出さない
  tail -n 20 /tmp/cloud-setup-pnpm.log | grep -viE 'token|auth|password|secret' | sed -E 's#://[^/@[:space:]]+@#://***@#g' >&2
fi

# root で動くので、apt で入れる --with-deps を付ける。
# 配布元（cdn.playwright.dev、playwright.download.prss.microsoft.com）を許可ドメインに足していないと失敗する
if [ -x node_modules/.bin/playwright ]; then
  pnpm exec playwright install --with-deps chromium >/tmp/cloud-setup-playwright.log 2>&1 \
    || warn "chromium を入れられなかった。許可ドメインを確かめる（/tmp/cloud-setup-playwright.log）"
fi

info "完了"
exit 0
