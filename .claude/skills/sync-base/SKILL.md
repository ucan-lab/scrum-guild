---
name: sync-base
description: 進んだベースブランチを fetch して、現在のブランチに merge で取り込み、通常の push まで行う。引数でブランチ名を渡せばそのブランチを取り込む。コンフリクトは意図が読めるものだけ解消する。このリポジトリでは rebase-base の代わりに使う。「ベースを取り込んで」「main に追従して」「rebase して」「ベースが進んだ」と言われたときに使う。
---

# sync-base

## 仕事

現在のブランチに、最新のベースを merge で取り込む。
終わりは「ベースの最新が HEAD の祖先になり、通常の push を終えた」状態。
merge で取り込む（理由: squash merge なので main の履歴には影響せず、レビューで読まれたコミットの SHA を保てる）。

force push は使わない。PR の指摘への対応と done-check の修正は、通常の push で積む。

## 入力

- 取り込むブランチ名（任意）。`origin/` 付きでも無しでも受ける
- 省略時は次の順で決める
  1. 現在のブランチの PR のベース: `gh api "repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open" --jq '.[0].base.ref'`
  2. PR が無ければ（出力が空か `null`）デフォルトブランチ: `gh api repos/{owner}/{repo} --jq .default_branch`

GitHub の操作は `gh api` の REST で行う（クラウドのセッションでは、GraphQL を使う `gh pr` が 403 で止まる）。`{owner}` `{repo}` `{branch}` が置き換わらずに 404 になるときは、`git remote get-url origin` と `git branch --show-current` から読んで直に書く。
`gh` が無いか認証で失敗するときは、`pr-create/github-mcp.md` に従い、GitHub の MCP ツールで代える（PR のベースは `list_pull_requests` の `head` で絞って `base` を見る）。

決めたベースは着手時に一文で伝える。

## 手順

### 1. 前提を確かめる

```bash
git status -s
git branch --show-current
```

- 未コミットの変更があれば止まり、コミットするか stash するかを `AskUserQuestion` で聞く。身に覚えのない変更なら並行セッションを疑い、触らずに伝える
- detached HEAD か `main` の上なら止まって伝える
- rebase か merge の途中なら止まって伝える。ワークツリーでは `.git` がファイルなので、場所は git に聞く

```bash
ls "$(git rev-parse --git-path rebase-merge)" "$(git rev-parse --git-path rebase-apply)" "$(git rev-parse --git-path MERGE_HEAD)" 2>/dev/null
```

### 2. fetch して遅れを見る

```bash
git fetch origin
git rev-parse HEAD                                   # 取り込み前のコミットとして控える
git merge-base --is-ancestor origin/<base> HEAD      # 0 なら取り込み済み
git rev-list --count HEAD..origin/<base>             # 遅れているコミット数
```

リモートにブランチがあれば（`git rev-parse --verify --quiet origin/<branch>` が成功すれば）、手元がリモートのコミットをすべて含むことを確かめる。

```bash
git merge-base --is-ancestor origin/<branch> HEAD
```

0 でなければ、`git merge --ff-only origin/<branch>` で追いつく。できなければ止まり、手元とリモートの差を示して伝える（理由: 別のセッションか人が push したコミットを、取り込みの前に確かめるため）。
リモートにブランチが無ければ、そのまま進む。
ベースの最新が HEAD の祖先なら手順 3 と 4 は飛ばし、手順 5 と 6 で確認して push する。

### 3. merge する

```bash
git merge origin/<base>
```

手元では sandbox の外で実行する（理由: `.claude/settings.json` が変わる merge は sandbox では書き込めずに途中で止まり、チェックアウト済みのファイルが作業ツリーに残る）。

### 4. コンフリクトを解消する

merge がコンフリクトで止まったら `git status -s` と `git diff` で衝突箇所を見て解消する。

merge の途中では、ours が自分のブランチの側、theirs がベースの側になる。`git checkout --ours` と `--theirs` を使うときは取り違えない。

- 両側の意図が読めるもの（片側の改名と片側の追記、隣接行の独立した変更など）は両方を活かして解消し、`git add` して `GIT_EDITOR=true git merge --continue`
- lockfile（`pnpm-lock.yaml` など）は手で混ぜない。ベースの側（`git checkout --theirs <lockfile>`）を採り、マニフェストに合わせてパッケージマネージャで作り直してから `git add` し、merge を続ける
- `migrations/` のファイルが衝突したら止まって伝える。番号の重なりは名前が違うと衝突にならないので、手順 5 で見る
- 仕様の選択が要るもの、どちらを残すべきか読めないものは、衝突箇所と両側の内容を示して `AskUserQuestion` で聞く。選択肢に「`git merge --abort` で取りやめる」を入れる

解消したファイルは、最後に一覧にして報告に含める。

### 5. 結果を確かめる

```bash
git merge-base --is-ancestor origin/<base> HEAD      # 0 であること
git merge-base --is-ancestor <手順 2 で控えた HEAD> HEAD  # 取り込み前のコミットが残ること
git diff --stat origin/<base>...HEAD                 # PR の差分が取り込み前と同じファイルに収まること
```

コンフリクトを解消した場合は、触ったファイルに関係するテストか lint を回す。

`migrations/` の番号の重なりも見る（理由: `0006_a.sql` と `0006_b.sql` のように名前が違うと、git は衝突にせず merge が黙って通る）。

```bash
ls migrations | cut -c1-4 | sort | uniq -d             # 何も出ないこと
```

出たら、重なったファイルがどちらの側かを `git log origin/<base> -- migrations/<ファイル>` で見る。

- 相手がベースに入っていて、自分の側が未マージなら、自分のファイルを次の空いた番号に `git mv` し、1行目の `-- Migration number:` も直す。ファイルの名前を指す文書とコメントも直す。手元の D1 には古い名前で当たった行が残り、新しい名前で同じものを作り直そうとして止まるので、`.wrangler/state/v3/d1` を消してから `pnpm db:migrate:fresh` を通してコミットする。e2e は手元で走らせず、push の後の CI に任せる
- 両方とも未マージ（ベースに無い）なら止まって伝える（マイグレーションを含む PR は同時に1本までの決まりに反している）

### 6. push して報告する

```bash
git push origin <branch>    # リモートに無ければ git push -u origin <branch>
```

non-fast-forward で失敗したら、手順 2 の後に誰かが push している。force push に切り替えずに止まり、`git fetch origin` の後に手元と `origin/<branch>` の差を示して伝える。

次を伝える。

- 取り込んだベースと SHA、取り込んだコミット数
- 解消したコンフリクトと、その解き方
