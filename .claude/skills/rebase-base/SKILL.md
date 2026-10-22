---
name: rebase-base
description: 進んだベースブランチを fetch して、現在のブランチに rebase で取り込む。引数でブランチ名を渡せばそのブランチを取り込む。コンフリクトは意図が読めるものだけ解消し、force push のコマンドを渡して終える。「ベースを取り込んで」「main に追従して」「rebase して」「ベースが進んだ」と言われたときに使う。
---

# rebase-base

## 仕事

現在のブランチを、最新のベースの上に rebase し直す。
終わりは「ベースの最新が HEAD の祖先になり、push のコマンドをユーザーに渡した」状態。
push はしない（理由: 履歴を書き換えた push は force push になり、取り込みの成否を見てからユーザーが判断する）。

## 入力

- 取り込むブランチ名（任意）。`origin/` 付きでも無しでも受ける
- 省略時は次の順で決める
  1. 現在のブランチの PR のベース: `gh api "repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open" --jq '.[0].base.ref'`
  2. PR が無ければ（出力が空か `null`）デフォルトブランチ: `gh api repos/{owner}/{repo} --jq .default_branch`

GitHub の操作は `gh api` の REST で行う（クラウドのセッションでは、GraphQL を使う `gh pr` が 403 で止まる）。`{owner}` `{repo}` `{branch}` が置き換わらずに 404 になるときは、`git remote get-url origin` と `git branch --show-current` から読んで直に書く。

PR のベースを先に見るのは、main 以外に向いた PR（スタック PR の上段など）を main に乗せ替えてしまわないため。
決めたベースは着手時に一文で伝える。

## 手順

### 1. 前提を確かめる

```bash
git status -s
git branch --show-current
```

- 未コミットの変更があれば止まり、コミットするか stash するかを `AskUserQuestion` で聞く。身に覚えのない変更なら並行セッションを疑い、触らずに伝える
- detached HEAD、または rebase / merge の途中（`.git/rebase-merge` などがある）なら止まって伝える
- 現在のブランチが gh-stack のスタックに入っているなら、このスキルを使わず `gh-stack` スキルの rebase に切り替える

### 2. fetch して遅れを見る

```bash
git fetch origin
git rev-parse HEAD                                   # 退避用に控える
git rev-parse --verify -q origin/<branch>            # push の期待 SHA として控える。無ければリモート未作成
git merge-base --is-ancestor origin/<base> HEAD      # 0 なら取り込み済み
git rev-list --count HEAD..origin/<base>             # 遅れているコミット数
```

取り込み済みなら、ベースの SHA を添えてそう伝えて終える。
`origin/<base>` が無い（ローカルにしかないブランチ）ときは fetch を飛ばしてローカルの `<base>` を使い、その旨を伝える。

### 3. rebase する

```bash
git rebase origin/<base>
```

手元では sandbox の外で実行する（理由: `.claude/settings.json` が変わる rebase は sandbox では書き込めずに途中で止まり、チェックアウト済みのファイルが作業ツリーに残る）。

### 4. コンフリクトを解消する

止まったら `git status -s` と `git diff` で衝突箇所を見て、1 コミットずつ解消する。

- 両側の意図が読めるもの（片側の改名と片側の追記、隣接行の独立した変更など）は両方を活かして解消し、`git add` して `GIT_EDITOR=true git rebase --continue`
- lockfile（`composer.lock`、`package-lock.json` など）は手で混ぜない。ベース側を採ってから、そのコミットのマニフェストに合わせてパッケージマネージャで作り直す
- 仕様の選択が要るもの、どちらを残すべきか読めないものは、衝突箇所と両側の内容を示して `AskUserQuestion` で聞く。選択肢に「`git rebase --abort` で取りやめる」を入れる

解消したファイルは、最後に一覧にして報告に含める。

### 5. 結果を確かめる

```bash
git merge-base --is-ancestor origin/<base> HEAD      # 0 であること
git log --oneline origin/<base>..HEAD                # 自分のコミットだけが並ぶこと
```

ベースのコミットが自分の側に混ざっていたら、rebase の起点がずれている。手順 2 で控えた SHA に戻せることを伝えて止まる。
コンフリクトを解消した場合は、触ったファイルに関係するテストか lint を回す。

### 6. 報告して push を渡す

次を伝える。

- 取り込んだベースと SHA、取り込んだコミット数
- 解消したコンフリクトと、その解き方
- 戻すときのコマンド: `git reset --hard <手順 2 で控えた SHA>`

リモートに同名ブランチがあれば、force push のコマンドを渡す。期待 SHA は手順 2 で控えた `origin/<branch>` を明示する（理由: URL 直指定で push したブランチだと、SHA 無しの `--force-with-lease` は stale info で弾かれる）。
手元では `!` 付きで渡し、ユーザーに打ってもらう。クラウドには `!` が無いので、コマンドを示して `AskUserQuestion` で許可を取ってから自分で実行する。

```bash
! git push --force-with-lease=<branch>:<手順 2 で控えた origin/<branch> の SHA> origin <branch>
```

リモートに無ければ通常の `git push -u origin <branch>` を渡す。
