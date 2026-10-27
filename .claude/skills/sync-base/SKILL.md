---
name: sync-base
description: 進んだベースブランチを fetch して、現在のブランチに rebase で取り込み、--force-with-lease で push まで行う。引数でブランチ名を渡せばそのブランチを取り込む。コンフリクトは意図が読めるものだけ解消する。このリポジトリでは rebase-base の代わりに使う。「ベースを取り込んで」「main に追従して」「rebase して」「ベースが進んだ」と言われたときに使う。
---

# sync-base

## 仕事

現在のブランチを、最新のベースの上に rebase で積み直す。
終わりは「ベースの最新が HEAD の祖先になり、`--force-with-lease` での push を終えた」状態。
merge では取り込まない（理由: PR の履歴に merge のコミットを残さない）。

force push はこのスキルの中だけで行う。PR の指摘への対応と done-check の修正は、通常の push で積む。

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
git rev-parse HEAD                                   # 取りやめるときの戻り先として控える
git merge-base --is-ancestor origin/<base> HEAD      # 0 なら取り込み済み
git rev-list --count HEAD..origin/<base>             # 遅れているコミット数
```

取り込み済みなら、ベースの SHA を添えてそう伝えて終える。

リモートにブランチがあれば（`git rev-parse --verify --quiet origin/<branch>` が成功すれば）、手元がリモートのコミットをすべて含むことを確かめ、push の lease に使う SHA を控える。

```bash
git merge-base --is-ancestor origin/<branch> HEAD    # 0 であること
git rev-parse origin/<branch>                        # lease に使う
```

0 でなければ、リモートに手元の無いコミットがある（別のセッションか人が push した）。rebase せずに止まり、そのコミットを示して伝える（理由: rebase の後の force push はリモートのブランチを手元の内容で置き換え、lease はそのコミットを守らない。lease が守るのは、最後に fetch した後の push だけ）。

リモートにブランチが無ければ、lease の SHA は控えない。手順 6 で通常の push をする。

PR の履歴に以前の merge のコミットがあると、rebase はそれを落として一直線に積み直す。merge のときに手で直した内容は、コンフリクトとしてもう一度出る。

### 3. rebase する

```bash
git rebase origin/<base>
```

手元では sandbox の外で実行する（理由: `.claude/settings.json` が変わる rebase は sandbox では書き込めずに途中で止まり、チェックアウト済みのファイルが作業ツリーに残る）。

### 4. コンフリクトを解消する

rebase はコミットごとに止まる。止まったら `git status -s` と `git diff` で衝突箇所を見て解消する。

rebase の途中では、ours がベースの側、theirs が積み直している自分のコミットの側になる（merge と逆）。`git checkout --ours` と `--theirs` を使うときは取り違えない。

- 両側の意図が読めるもの（片側の改名と片側の追記、隣接行の独立した変更など）は両方を活かして解消し、`git add` して `GIT_EDITOR=true git rebase --continue`
- 解消した結果コミットが空になり、`--continue` が止まったら、そのコミットの変更はベースに入っている。`git rebase --skip` で飛ばし、報告に書く
- lockfile（`pnpm-lock.yaml` など）は手で混ぜない。衝突のたびにベースの側（`git checkout --ours <lockfile>`）を採って進め、rebase を終えた後に1回だけ、マニフェストに合わせてパッケージマネージャで作り直してコミットする
- `migrations/` のファイルが衝突したら止まって伝える。番号の重なりは名前が違うと衝突にならないので、手順 5 で見る
- 仕様の選択が要るもの、どちらを残すべきか読めないものは、衝突箇所と両側の内容を示して `AskUserQuestion` で聞く。選択肢に「`git rebase --abort` で取りやめる」を入れる

解消したファイルは、最後に一覧にして報告に含める。

### 5. 結果を確かめる

```bash
git merge-base --is-ancestor origin/<base> HEAD      # 0 であること
git diff --stat origin/<base>...HEAD                 # PR の差分が取り込み前と同じファイルに収まること
```

コンフリクトを解消した場合は、触ったファイルに関係するテストか lint を回す。

`migrations/` の番号の重なりも見る（理由: `0006_a.sql` と `0006_b.sql` のように名前が違うと、git は衝突にせず rebase が黙って通る）。

```bash
ls migrations | cut -c1-4 | sort | uniq -d             # 何も出ないこと
```

出たら、重なったファイルがどちらの側かを `git log origin/<base> -- migrations/<ファイル>` で見る。

- 相手がベースに入っていて、自分の側が未マージなら、自分のファイルを次の空いた番号に `git mv` し、1行目の `-- Migration number:` も直す。ファイルの名前を指す文書とコメントも直す。手元の D1 には古い名前で当たった行が残り、新しい名前で同じものを作り直そうとして止まるので、`.wrangler/state/v3/d1` を消してから `pnpm db:migrate:fresh` と、関わる e2e を通してコミットする
- 両方とも未マージ（ベースに無い）なら止まって伝える（マイグレーションを含む PR は同時に1本までの決まりに反している）

### 6. push して報告する

手順 2 で控えた `origin/<branch>` の SHA を lease に渡す（理由: SHA を省くと、push の時点の追跡ブランチと比べる。手順 2 の後に別のプロセスが fetch していると、その間の他人の push を消す）。

```bash
git push --force-with-lease=<branch>:<控えた SHA> --force-if-includes origin <branch>    # リモートに無ければ git push -u origin <branch>
```

作業ブランチへの `--force-with-lease` は、フックと `.claude/settings.json` の `permissions.allow` で確認なしに通す。それでも止められたら、同じコマンドを `!` 付きで人に渡す。
lease が外れて失敗したら（stale info）、手順 2 の後に誰かが push している。やり直さずに止まり、手順 2 で控えた HEAD と、`git fetch origin` の後の `origin/<branch>` の差を示して伝える（理由: 手元は rebase 済みなので、手順 2 に戻ると「取り込み済み」で終わり、リモートの新しいコミットを確かめないまま進む）。

次を伝える。

- 取り込んだベースと SHA、取り込んだコミット数
- 解消したコンフリクトと、その解き方
