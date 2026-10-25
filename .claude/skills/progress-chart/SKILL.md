---
name: progress-chart
description: 人の手元の進捗の図（claude.ai の Artifact「Scrum Guild 進捗」）を、GitHub の Issue と PR の今の状態に合わせて直して出し直す。「進捗の図を更新して」と言われたとき、Issue を分けた後、PR がマージされた後に使う。
---

# progress-chart

## 仕事

進捗の図を GitHub の今の状態に合わせ、同じ URL のまま出し直す。
終わりは「図の Issue の状態、ストーリー、依存が GitHub と一致し、足元の日付が今日になった版が出ている」状態。
図は人の手元のもので、Artifact のツールがあるセッション（手元）でだけ直す。

- URL: https://claude.ai/artifact/AVrhMgarMzbpHFwAKYtM4Z （作った人だけの非公開）
- 人が開いて一番知りたいのは、ページの一番上の「次に着手するもの」

## 手順

### 1. 最新の版を取る

`Artifact` の `action: "read"` に URL を渡して読み、続けて `path: "index.html"` でも読む。前者は出し直しに要る読み取りで、後者がスクラッチパッドに保存するページのファイルを直す。
ほかのセッションも出し直すので、直す前に必ず最新の版を取り直す。出し直しが新しい版との衝突で断られたら、その版を取り直して直しを重ねる。

### 2. GitHub の状態を引く

```bash
gh api "repos/{owner}/{repo}/issues?state=all&per_page=100" --paginate --jq '.[] | select(.pull_request | not) | "\(.number) \(.state) \(.state_reason) \([.labels[].name] | join(","))"'
gh api "repos/{owner}/{repo}/pulls?state=open&per_page=100" --jq '.[] | "\(.number) \(.head.ref)"'
```

ラベルの絞り込み（`labels=a,b`）は AND になるので、全件を引いて手元で分ける。

### 3. ページを直す

ページの JS は2つに分かれる。

- `ROWS`: Issue の番号から行へ。`s`（状態）、`t`（題）、`lanes`（作る場所の列）、`deps`（前に要るもの）、`note`、`tags`
- `SECTIONS`: ストーリーの並び。`kind: "story"` は `n`（ストーリーの番号）、`title`、`accept`（受け入れ条件）、`epic`、`epicName`（一本道でないエピックの名前）、`base`（土台）、`closed`、`rows`（タスクの番号を作る順に。タスクの無いストーリーは自分の番号）を持つ。ほかに `epics`（まだ分けていないエピック、`FEATURE_EPICS`）、`human`（人が確かめること）、`other`（見本）

次の決まりで直す。

- `s` は推測せず GitHub から読む（`docs/development.md` の「Issue の状態」）。閉じていれば `done`、開いた PR があれば `review`、`status:in-progress` なら `wip`（`status:refining` と両方あっても `wip`）、`status:refining` なら `refining`、どれでもなければ `todo`。開いた PR はブランチ名の先頭の番号で引く
- 閉じた Issue を `done` にする前に、`state_reason` が `not_planned`（重複や対応しない）でないかを確かめる。そうなら図から外す
- PR を出した Issue は、`note` を「PR #nn」で始める。ページが番号を取って列のブロックに出す
- 開いている Issue の `deps` は、GitHub の依存関係（`gh api repos/{owner}/{repo}/issues/<番号>/dependencies/blocked_by --jq '[.[].number]'`）に合わせる。閉じた Issue の `deps` は残す。「待ち」と待っている番号はページが `deps` から出すので、手で書かない
- `lanes` は `area:` のラベルとは別に、Issue の中身から作る場所（見本、画面、運用者、API、DB、定期処理、基盤、文書）を割り当てる
- 新しいストーリー（`story` のラベル）は、`n` を付けて `SECTIONS` に足す。エピックをストーリーに分けたら、`FEATURE_EPICS` から抜き、ストーリーを作る順（並べる回の順）に足す
- ストーリーの Issue が閉じたら `closed: true` を付ける。付いていないと、タスクが済んだストーリーは「受け入れ待ち」として一番上の「あなたの番」に出る
- `SECTIONS` の並びは作る順のまま、手で動かさない。タスクがすべて済んだストーリーは、ページが畳んで一番下にまとめる
- 図に載せない閉じた chore は `doneIssues` に足す
- 導入文に済んだ経緯を書き足さない。依存の矢印は、見づらいので描かない

### 4. 出し直す

足元の日付（`asof`）を今日に直す。ページの `<script>` の中身をファイルに抜き出して `node --check` で構文を確かめてから、同じファイルのパスと URL で出し直す。
