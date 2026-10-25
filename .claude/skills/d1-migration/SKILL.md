---
name: d1-migration
description: 戻せない D1 のマイグレーションを書く手順。広げる変更は同じ PR で、縮める変更（消す、名前を変える、型を変える、制約を足すか狭める）は先に使わなくする版を出してから別の PR で行う。並行の確かめ、data-model.md の直し、空の D1 と行の入った D1 での確かめ、PR に書くことまでを扱う。マイグレーションを足す、表や列を足す、消す、名前を変える、制約や索引を変える、スキーマを変えるときに使う。
---

# d1-migration

## 仕事

`migrations/` に新しい SQL のファイルを1つ足し、PR を作れる状態にする。
終わりは「空の D1 に全マイグレーションが当たり、`docs/data-model.md` が同じ差分で直り、PR の本文に下の手順 7 の内容がある」状態。

前提（理由も含めて守る）。

- D1 のマイグレーションは戻せない。ステージングも無い。本番に当てるのは Workers Builds のデプロイのスクリプトだけで、マイグレーションを当ててから版を切り替える。煙のテストに落ちたら、コードだけを1つ前の版に戻す（`docs/development.md` の「CD」）。そのため、新しいスキーマの上で1つ前の版のコードが動く変更しか、1つの PR に入れられない
- `--remote` は使わない。付けた wrangler は本番の D1 に触る。フック（`guard-bash.mjs`）も止める
- 既にあるマイグレーションのファイルは開いて読むだけにする。本番の D1 は当てたファイルの名前しか覚えていないので、書き換えた中身は本番に届かず、手元と本番のスキーマがずれる。直すときは新しい番号のファイルを足す。`main` にあるファイルの書き換えはフック（`guard-files.mjs`）も止める
- 表と列の決まりは `docs/data-model.md` の「決まりごと」と「データベースの分け方」、レビューで見る項目は `.claude/checklists/database.md`。このスキルは手順を書き、決まりそのものはそちらを読む

マイグレーションのまとめ直し（既にあるファイルを1つにまとめ、本番の D1 を作り直す）は、このスキルの範囲の外。人が決めた Issue の中でだけ行い、そのときは Issue の指示に従う（`docs/development.md` の「DB を作り直してよい期間」）。

GitHub の操作は `gh api` の REST で行う（理由: クラウドのセッションでは、GraphQL を使う `gh pr` と `gh issue` が 403 で止まる）。

## 広げる変更と縮める変更

1つ前の版のコードが新しいスキーマで動くかで分ける。

| 区分 | 変更 | 扱い |
| --- | --- | --- |
| 広げる | 表を足す、空にできる列を足す、既定値のある `NOT NULL` の列を足す、索引を足す（一意でないもの）、CHECK の列挙に値を足す | 使うコードと同じ PR でよい |
| 縮める | 表や列を消す、名前を変える、型を変える、`NOT NULL`・CHECK・UNIQUE（一意の索引）・外部キーを足すか狭める | 先に使わなくする（新しい制約を守る）版を出し、その版が本番に出た後の別の PR で行う |

縮める変更を同じ版に入れると、戻した古いコードが消えた列を読むか、新しい制約に当たる行を書いて落ちる。

既定値の無い `NOT NULL` の列を足すのは、古いコードの `INSERT` がその列を書かないので縮める側になる。既定値を付けて広げる側にする。

## 手順

### 1. 着手の前に並行を確かめる

マイグレーションを含む PR は同時に1本まで（理由: 番号がぶつかる。`docs/development.md` の「並行して作業するときの決まり」）。

```bash
gh api repos/{owner}/{repo}/issues/<Issue番号> --jq '[.labels[].name]'                    # migration があること
gh api "repos/{owner}/{repo}/pulls?state=open&per_page=100" --jq '.[] | {number, head: .head.ref}'
gh api "repos/{owner}/{repo}/pulls/<PR番号>/files?per_page=100" --jq '[.[].filename | select(startswith("migrations/"))]'   # 開いた PR ごとに
gh api "repos/{owner}/{repo}/issues?labels=migration&state=open&per_page=100" --jq '.[] | select(.pull_request | not) | .number'
git ls-remote --heads origin '<他の Issue の番号>-*'                                         # 作業中のブランチがあるか
```

- Issue に `migration` のラベルが無ければ、止まって伝える
- 開いた PR の変更ファイルに `migrations/` があれば、止まって人に聞く。PR には `migration` のラベルが付かないので、ラベルでは見ない
- `migration` のラベルの付いた他の開いた Issue に作業中のブランチがあれば、止まって人に聞く。クラウドのセッションのブランチ（`claude/*`）は Issue と結べないので、開いた PR の確かめで拾う
- 縮める Issue なら、続けて手順 5 の「縮める Issue に着手するとき」を確かめる

### 2. 表と列を決める

`docs/data-model.md` を先に直し、マイグレーションと同じ PR に入れる。

- 共通の表か組織の中の表かを決め、「共通の表と組織の中の表」の表に足す
- 組織の中の表から共通の表へ張ってよい外部キーは、`users.account_id` と、`users`、`workspaces`、`organization_holidays`、`change_logs` の `organization_id` だけ。共通の表から組織の中の表へは張らない（理由: 後で組織ごとに D1 を分けるとき、これらだけを外してアプリの検査に替える）
- 変えた表を seed（`seed/`）が入れていれば、seed も同じ PR で直す

### 3. ファイルを作る

```bash
pnpm exec wrangler d1 migrations create DB <名前>
```

フックが確認を挟む。`<名前>` は英語の小文字とスネークケースで、変更が分かるもの（例 `add_sprints`、`add_tasks_today_on`）。
番号は wrangler が `migrations/` の最大の番号の次を振る。

### 4. SQL を書く

決まりは `docs/data-model.md` の「決まりごと」に従う。主に当たるもの: 主キーは UUIDv7 の `TEXT`、日時の `_at`、日付の `_on` と月の `_month` の CHECK、真偽の `is_`、列挙の CHECK、`_json` の `json_valid`、本文の長さの CHECK、論理削除の部分索引、`ON DELETE` を付けない。取り込み元に固有の値（取り込み元の種類、取り込む範囲の種類）は CHECK に書かない（理由: SQLite では CHECK を後から変えられず、取り込み元を足すたびに表の作り直しになる）。

- `BEGIN TRANSACTION` と `COMMIT` は書かない。D1 が1つのファイルを1つのトランザクションで当て、wrangler は書かれた `BEGIN TRANSACTION;` を外し、2つ以上あれば失敗する
- 行を書き換える文は、次の2つだけにする
  - 表の作り直しで、古い表の行を新しい表へ写す文
  - 足した列を、既にある行から SQL で計算して埋める文（例: 足した `xxx_on` を `created_at` の日付で埋める）
- 決まった行の投入と開発用の値（seed のセッション、架空の組織）は入れない。アプリか seed が持つ（理由: マイグレーションは本番にも当たる）
- 全行を更新する文には、本番の行数の見積もりと、かかる時間の見込みを PR に書く。D1 は1つの問い合わせの時間に上限があり、デプロイの中で落ちると版を切り替えずに止まる

#### 表の作り直し

SQLite の `ALTER TABLE` でできない変更（制約の追加、列の型の変更、CHECK の列挙に値を足す）は、表を作り直して行う。D1 では `PRAGMA foreign_keys = OFF` が効かないので、外部キーの検査をトランザクションの終わりまで遅らせる。

```sql
PRAGMA defer_foreign_keys = true;

CREATE TABLE tasks_new (
  -- 新しい定義。docs/data-model.md と一致させる
);
INSERT INTO tasks_new (id, workspace_id, ...) SELECT id, workspace_id, ... FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

-- DROP TABLE で古い表の索引も消えるので、すべて張り直す
CREATE INDEX ...;

PRAGMA defer_foreign_keys = false;
```

- `INSERT ... SELECT` の列は両方とも名前で並べる（理由: `SELECT *` は列の順が変わると黙って別の列に入る）
- 新しい CHECK や `NOT NULL` に当たる行があると、ここで落ちる。手順 6 の行の入った D1 で確かめる
- 大きな表の作り直しは、本番のデータ量で時間がかかる旨を PR に書く

### 5. 広げてから縮める

上の「広げる変更と縮める変更」で区分を決める。

広げる変更は、使うコードと同じ PR に入れてよい。新しい列や表を使うコードが入っても、戻した古いコードはそれを読まないだけで動く。

縮める変更は2つの PR に分ける。

1. 1つ目の PR: コードが消す列を使わなくする、または新しい制約を守るようにする。マイグレーションは入れないか、広げる変更だけにする
2. 2つ目の PR: 縮めるマイグレーションを入れる。1つ目の PR の版が本番に出た後に着手する

1つ目の PR を作るセッションは、縮める Issue を `issue-plan` の形で立て、`migration` のラベルを付け、1つ目の PR の本文から指す。Issue の背景に「1つ目の PR（#<番号>）の版が本番に出てから着手する」と書く（理由: 縮める作業は後回しにすると忘れられ、使わない列や付いていない制約が残る。セッションは前の会話を覚えていない）。

```bash
gh api repos/{owner}/{repo}/issues -f title="<件名>" -F body=@<file> -f 'labels[]=migration' --jq '{number, url: .html_url}'
```

#### 縮める Issue に着手するとき

1つ目の PR の版が本番に出たことを確かめる。マージしただけでは足りない（Workers Builds のデプロイが通って版が切り替わって初めて、戻し先の版が使わなくした版になる）。

```bash
gh api repos/{owner}/{repo}/pulls/<1つ目の PR の番号> --jq '{merged_at, merge_commit_sha}'
curl -fsS https://scrum-guild.ucan-lab.workers.dev/api/health                               # version が本番の版のコミットの SHA
git fetch origin
git merge-base --is-ancestor <merge_commit_sha> <version>                                  # 0 なら出ている
```

0 でなければ止まって伝える。`version` が SHA でなければ（`dev` など）、デプロイの状態を判定できないので止まって伝える。

### 6. 確かめる

空の D1 に全マイグレーションを当てる。

```bash
pnpm db:migrate:fresh
pnpm test
```

`pnpm db:migrate:fresh` は一時の場所に空の D1 を作って当てる（手元の `.wrangler/state` の D1 は前に当てた状態から始まるので、空の確かめにならない）。CI の migration のジョブも同じことをする。テストは全マイグレーションを当てた D1 で回る。

縮めるとき（表の作り直し、制約か一意の索引を足す）は、行の入った D1 にも当てる。本番は行の入った D1 に当てるので、空の D1 では通っても本番だけで落ちる変更がある（既に重なる行がある列に一意の索引を足す、作り直しの写しが新しい CHECK に当たる）。

```bash
git worktree add --detach worktrees/main-snapshot origin/main
mkdir -p <スクラッチパッド>/d1-with-rows
pnpm exec wrangler d1 migrations apply DB --local --persist-to <スクラッチパッド>/d1-with-rows --config worktrees/main-snapshot/wrangler.jsonc
pnpm exec wrangler d1 execute DB --local --persist-to <スクラッチパッド>/d1-with-rows --config worktrees/main-snapshot/wrangler.jsonc --file worktrees/main-snapshot/seed/<seed のファイル>
pnpm exec wrangler d1 migrations apply DB --local --persist-to <スクラッチパッド>/d1-with-rows      # 新しいファイルだけが当たる
git worktree remove worktrees/main-snapshot
```

- `--config` を渡すと、wrangler はその設定の `migrations_dir` から読む。`main` の状態に `main` の seed を入れてから、作業中のブランチの設定で当て直すと、`main` に無い新しいファイルだけが当たる
- seed のファイルと流す順は `seed/` の README に従う
- seed では本番の行の重なりまでは再現できない。一意や CHECK を足すときは、本番の既にある行が満たす理由（例: アプリが前の版から同じ検査をしている）を PR に書く

`--remote` は使わない（本番に当てるのは Workers Builds だけ）。

### 7. PR を作る

PR を作る直前に、手順 1 の開いた PR の確かめをもう一度行う（理由: 作業の間に別のセッションが PR を出していることがある）。当たったら止まって人に聞く。すり抜けて後から番号がぶつかったときは、`sync-base` が止まる。

`migrations/` に触れた PR には、`label` のワークフローが `needs-human` を自動で付ける。PR の本文（`pr-create`）に次を書く。

- 人のマージが本番に当てる承認になること。マージすると Workers Builds が本番の D1 に当ててから版を切り替える
- 広げる変更か縮める変更か。縮める変更なら、1つ目の PR と、その版が本番に出たことを確かめた結果
- 戻すときは、コードだけを `wrangler rollback`（デプロイのスクリプトか人）で戻し、スキーマは戻さないこと。1つ前の版のコードが新しいスキーマで動く理由
- 全行の更新か大きな表の作り直しがあれば、本番の行数の見積もりとかかる時間の見込み
- 一意や CHECK を足すなら、本番の既にある行が満たす理由
- 縮める変更を後に回したなら、立てた縮める Issue

`self-review` では `database-reviewer` が `.claude/checklists/database.md` を当てる。

## 報告

次を伝える。

- 足したファイルと、広げる変更か縮める変更か
- 手順 6 で当てた D1（空、行の入った D1）と結果
- 立てた縮める Issue があればその番号
