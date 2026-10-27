#!/bin/bash
# クラウド環境のセットアップスクリプト。中身をクラウド環境の設定に貼って使う（docs/development.md の「クラウド環境」）。
# VM の用意だけを受け持つ（Node、pnpm、pnpm のストア、Playwright の chromium）。依存の導入は毎回 session-start.sh が行い、
# ここで温めたストアから組む。終了コードが 0 以外だとセッションが始まらないので、どの段の失敗も警告にとどめて先へ進む。
# 約5分を超えるとスナップショットが作られないので、全体を 270 秒の予算に収め、各段の上限を残りの時間で切り詰める。
set -u

warn() { echo "[cloud-setup] 警告: $*" >&2; }
info() { echo "[cloud-setup] $*"; }

deadline=270
# 段の上限（秒）を、予算の残りで切り詰めて出す。残りが 20 秒を切れば失敗する
cap() {
  local left=$((deadline - SECONDS))
  [ "$left" -ge 20 ] || return 1
  echo $(($1 < left ? $1 : left))
}
# 上限付きで動かす。予算が尽きていれば動かさず失敗する
within() {
  local limit
  limit=$(cap "$1") || { warn "時間の予算が尽きたので飛ばす: ${*:2}"; return 124; }
  timeout "$limit" "${@:2}"
}
fetch() {
  local limit
  limit=$(cap 90) || { warn "時間の予算が尽きたので取らない: ${*: -1}"; return 1; }
  curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 10 --max-time "$limit" "$@"
}

is_repo() { [ -f "$1/package.json" ] && grep -q '"name": "scrum-guild"' "$1/package.json"; }

# 走る時点の clone の置き場所は文書に書かれていないので、いくつかの場所を見る
repo=""
for dir in "$PWD" /home/user/scrum-guild /root/scrum-guild /workspace/scrum-guild; do
  if is_repo "$dir"; then
    repo="$dir"
    break
  fi
done
if [ -z "$repo" ]; then
  while IFS= read -r found; do
    if is_repo "$(dirname "$found")"; then
      repo=$(dirname "$found")
      break
    fi
  done < <(find /home /root /workspace -maxdepth 3 -name package.json -path '*scrum-guild*' 2>/dev/null)
fi
if [ -n "$repo" ]; then
  info "リポジトリ: $repo"
else
  warn "リポジトリが見つからないので、版は既定の値を使い、ストアと chromium は用意しない"
fi

# 版はリポジトリから読む。リポジトリが見つからないときのために既定の値を持つ（.node-version と packageManager に合わせて上げる）
node_spec=26
pnpm_version=12.12.0
if [ -n "$repo" ]; then
  v=$({ tr -d '[:space:]' < "$repo/.node-version"; } 2>/dev/null)
  v=${v#v}
  if [[ "$v" =~ ^[0-9]+(\.[0-9]+\.[0-9]+)?$ ]]; then
    node_spec="$v"
  else
    warn ".node-version を読めない（'$v'）ので Node ${node_spec} を入れる"
  fi
  v=$(sed -nE 's/.*"packageManager": "pnpm@([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' "$repo/package.json")
  if [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    pnpm_version="$v"
  else
    warn "packageManager から pnpm の版を読めないので ${pnpm_version} を入れる"
  fi
fi
node_major=${node_spec%%.*}
node_dir="/opt/node${node_major}"
if [[ "$node_spec" == *.* ]]; then
  node_base="https://nodejs.org/dist/v${node_spec}"
else
  node_base="https://nodejs.org/dist/latest-v${node_major}.x"
fi

# VM の既定は Node 22。nodejs.org から入れ、同じ配布元の SHASUMS256.txt で照らす（防げるのは取得の破損まで）
install_node() {
  local tmp rc
  tmp=$(mktemp -d)
  install_node_in "$tmp"
  rc=$?
  rm -rf "$tmp"
  return $rc
}
install_node_in() {
  local tmp=$1 sums file
  sums=$(fetch "$node_base/SHASUMS256.txt") || { warn "$node_base/SHASUMS256.txt を取れない"; return 1; }
  file=$(echo "$sums" | awk '{print $2}' | grep -E '^node-v[0-9.]+-linux-x64\.tar\.xz$' | head -n 1)
  [ -n "$file" ] || { warn "$node_base に linux-x64 の配布が見つからない"; return 1; }
  fetch -o "$tmp/$file" "$node_base/$file" || { warn "$file を取れない"; return 1; }
  (cd "$tmp" && echo "$sums" | grep " $file\$" | sha256sum -c --status) || { warn "$file のチェックサムが合わない"; return 1; }
  mkdir "$tmp/node"
  tar --no-same-owner -xJf "$tmp/$file" -C "$tmp/node" --strip-components=1 || { warn "$file を展開できない"; return 1; }
  # Node 26 の Linux の配布は libatomic.so.1 を要る。素の Ubuntu には無い
  if ! ldconfig -p | grep -q 'libatomic\.so\.1'; then
    { within 60 apt-get update -qq && within 60 apt-get install -y -qq libatomic1; } >/dev/null 2>&1 \
      || warn "libatomic1 を apt で入れられなかった"
  fi
  "$tmp/node/bin/node" --version >/dev/null 2>&1 || { warn "展開した node が動かない"; return 1; }
  # 動くと確かめてから入れ替える。途中で失敗しても前の版を消さない
  rm -rf "$node_dir"
  mv "$tmp/node" "$node_dir"
}
if install_node; then
  # VM の PATH には /opt/node22/bin があるので、シェルの初期化で先頭に足す（Claude の Bash は初期化ファイルから環境を作る）。
  # Ubuntu の .bashrc は対話でないと冒頭で return するので、末尾ではなく先頭に置く
  line="export PATH=\"${node_dir}/bin:\$PATH\""
  echo "$line" >/etc/profile.d/scrum-guild-node.sh
  if ! grep -qxF "$line" /root/.bashrc 2>/dev/null; then
    { echo "$line"; cat /root/.bashrc 2>/dev/null; } >/root/.bashrc.new && mv /root/.bashrc.new /root/.bashrc
  fi
  export PATH="${node_dir}/bin:$PATH"
  hash -r
else
  warn "Node ${node_spec} を入れられなかった。VM の既定の Node で続ける"
fi
info "node: $(command -v node) $(node --version 2>/dev/null)"

# Node 25 からは corepack が同梱されないので、packageManager の版を npm で入れる
if within 60 npm install -g --ignore-scripts "pnpm@${pnpm_version}" >/dev/null 2>&1; then
  hash -r
else
  warn "pnpm@${pnpm_version} を入れられなかった"
fi
info "pnpm: $(command -v pnpm) $(pnpm --version 2>/dev/null)"

if [ -n "$repo" ] && cd "$repo"; then
  # ストアはリポジトリの外にあり、スナップショットに残る。スナップショットを作るときのブランチのスクリプトを
  # root で動かして後のセッションに残さないよう、--ignore-scripts にする（毎回の session-start.sh はスクリプトも動かす）
  log=$(mktemp)
  if within 120 pnpm install --frozen-lockfile --ignore-scripts >"$log" 2>&1; then
    # 記録は伏せる処理を通していないので、スナップショットに残さない
    rm -f "$log"
  else
    warn "pnpm install が失敗した（$log の末尾）"
    # .npmrc の認証の値や、URL に埋めた user:pass が出力に混ざっても出さない
    tail -n 20 "$log" | grep -viE 'token|auth|password|secret' | sed -E 's#://[^/@[:space:]]+@#://***@#g' >&2
  fi

  # 配布元（cdn.playwright.dev、playwright.download.prss.microsoft.com）を許可ドメインに足していないと失敗する。
  # 動かすのに要るライブラリは apt で入れる。apt の失敗でブラウザの取得を止めないよう、別の段にする
  if [ -x node_modules/.bin/playwright ]; then
    within 90 node_modules/.bin/playwright install chromium >/dev/null 2>&1 \
      || warn "chromium を入れられなかった。許可ドメインを確かめる"
    within 90 node_modules/.bin/playwright install-deps chromium >/dev/null 2>&1 \
      || warn "chromium の動くライブラリを apt で入れられなかった"
  fi
fi

# セッションの Bash と同じく、初期化ファイルを読んだシェルで選ばれる版を確かめる
got=$(bash -ic 'node --version' 2>/dev/null | tail -n 1)
if [[ "$got" != "v${node_major}."* ]]; then
  warn "初期化ファイルを読んだシェルの node が ${got:-不明} で、${node_major} と合わない"
fi

info "完了"
exit 0
