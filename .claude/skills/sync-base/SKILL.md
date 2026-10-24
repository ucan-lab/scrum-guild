---
name: sync-base
description: 進んだベースブランチを fetch して、現在のブランチに rebase で取り込み、--force-with-lease で push まで行う。引数でブランチ名を渡せばそのブランチを取り込む。コンフリクトは意図が読めるものだけ解消する。このリポジトリでは rebase-base の代わりに使う。「ベースを取り込んで」「main に追従して」「rebase して」「ベースが進んだ」と言われたときに使う。
---

# sync-base

## 仕事

現在のブランチを、最新のベースの上に rebase で積み直す。
終わりは「ベースの最新が HEAD の祖先になり、`--force-with-lease` での push を終えた」状態。
merge では取り込まない（理由: PR の履歴に merge のコミットを残さない）。

force push はこのスキルの中だけで行う。PR の指摘への対応と self-review の修正は、通常の push で積む。

## 入力

- 取り込むブランチ名（任意）。`origin/` 付きでも無しでも受ける
- 省略時は次の順で決める
  1. 現在のブランチの PR のベース: `gh api "repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open" --jq '.[0].base.ref'`
  2. PR が無ければ（出力が空か `null`）デフォルトブランチ: `gh api repos/{owner}/{repo} --jq .default_branch`

GitHub の操作は `gh api` の REST で行う（クラウドのセッションでは、GraphQL を使う `gh pr` が 403 で止まる）。`{owner}` `{repo}` `{branch}` が置き換わらずに 404 になるときは、`git remote get-url origin` と `git branch --show-current` から読んで直に書く。

決めたベースは着手時に一文で伝える。

## 手順

### 1. 前提を確かめる

```bash
git status -s
git branch --show-current
```

- 未コミットの変更があれば止まり、コミットするか stash するかを `AskUserQuestion` で聞く。身に覚えのない変更なら並行セッションを疑い、触らずに伝える
- detached HEAD、`main` の上、または rebase / merge の途中（`.git/rebase-merge`、`MERGE_HEAD` などがある）なら止まって伝える

### 2. fetch して遅れを見る

```bash
git fetch origin
git rev-parse HEAD                                   # 取りやめるときの戻り先として控える
git rev-parse origin/<branch>                        # push のときの lease に使う。リモートに無ければ控えない
git merge-base --is-ancestor origin/<base> HEAD      # 0 なら取り込み済み
git rev-list --count HEAD..origin/<base>             # 遅れているコミット数
```

取り込み済みなら、ベースの SHA を添えてそう伝えて終える。

`git rev-list --count origin/<branch>..HEAD` が 0 でなく、手元にしか無いコミットがあれば、先に通常の push を済ませる（理由: rebase の後の force push は、リモートのブランチを手元の内容で置き換える）。

### 3. rebase する

```bash
git rebase origin/<base>
```

手元では sandbox の外で実行する（理由: `.claude/settings.json` が変わる rebase は sandbox では書き込めずに途中で止まり、チェックアウト済みのファイルが作業ツリーに残る）。

### 4. コンフリクトを解消する

rebase はコミットごとに止まる。止まったら `git status -s` と `git diff` で衝突箇所を見て解消する。

- 両側の意図が読めるもの（片側の改名と片側の追記、隣接行の独立した変更など）は両方を活かして解消し、`git add` して `GIT_EDITOR=true git rebase --continue`
- lockfile（`pnpm-lock.yaml` など）は手で混ぜない。ベース側を採ってから、マニフェストに合わせてパッケージマネージャで作り直す
- `migrations/` の番号がぶつかったら止まって伝える（マイグレーションを含む PR は同時に1本までの決まりに反している）
- 仕様の選択が要るもの、どちらを残すべきか読めないものは、衝突箇所と両側の内容を示して `AskUserQuestion` で聞く。選択肢に「`git rebase --abort` で取りやめる」を入れる

解消したファイルは、最後に一覧にして報告に含める。

### 5. 結果を確かめる

```bash
git merge-base --is-ancestor origin/<base> HEAD      # 0 であること
git diff --stat origin/<base>...HEAD                 # PR の差分が取り込み前と同じファイルに収まること
```

コンフリクトを解消した場合は、触ったファイルに関係するテストか lint を回す。

### 6. push して報告する

手順 2 で控えた `origin/<branch>` の SHA を lease に渡す（理由: SHA を省くと、fetch した時点の追跡ブランチと比べるので、別の経路で push されたブランチでは stale info で失敗するか、他人の push を消す）。

```bash
git push --force-with-lease=<branch>:<控えた SHA> origin <branch>    # リモートに無ければ git push -u origin <branch>
```

フックが確認を挟む。auto モードの分類器などに止められたら、同じコマンドを `!` 付きで人に渡す。
lease が外れて失敗したら（stale info）、誰かが push している。手順 2 からやり直す。

次を伝える。

- 取り込んだベースと SHA、取り込んだコミット数
- 解消したコンフリクトと、その解き方
