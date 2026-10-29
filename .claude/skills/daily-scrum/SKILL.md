---
name: daily-scrum
description: スプリントのゴールに向けて今の状態を点検し（済み ÷ 計画、残りの日数、待ち、受け入れ待ちの滞り、作業中と上限）、人の手元の進捗の図（claude.ai の Artifact「Scrum Guild 進捗」）を GitHub に合わせて直し、着手を選ぶなら backlog-pick へ続ける。「デイリースクラム」「今日の状況」「進捗の図を更新して」と言われたとき、Issue を分けた後、PR がマージされた後に使う。スプリントの計画と締めは sprint-plan、受け入れは sprint-review。
---

# daily-scrum

## 仕事

スプリントのゴールに届くかを点検し、人が今日決めることを出す。手元のセッションでは、進捗の図も GitHub の今の状態に合わせて同じ URL のまま出し直す。
終わりは「点検の結果が出て、手元なら図の Issue の状態、ストーリー、依存、スプリントの節が GitHub と一致し、足元の日付が今日になった版が出ている」状態。
このスキルは Issue を書き換えない。計画を変えるか（スプリントから外す、途中で足す）は人が決め、ラベルの付け外しは人の答えを受けて `sprint-plan` か人が行う。

- 図の URL: https://claude.ai/artifact/AVrhMgarMzbpHFwAKYtM4Z （作った人だけの非公開）
- 人が図を開いて一番知りたいのは、ページの一番上の「次に着手するもの」

`pr-feedback` のマージの後片付けから「図だけ」と渡されたときは、手順 2 と 4 を飛ばし、手順 3 だけを行う。

## GitHub の操作

`gh api` の REST で読む。クラウドのセッションでは、GraphQL を使う `gh issue` が 403 で止まるため。
`{owner}` と `{repo}` は `gh` がカレントのリポジトリに置き換える。`gh` は1行に1つで打ち、パイプやリダイレクトでつながない（加工は `--jq` で行う）。
`gh` が無いか認証で失敗するときは、`pr-create/github-mcp.md` に従い、GitHub の MCP ツールで代える。

## 手順

### 1. 状態を引く

```bash
gh api "repos/{owner}/{repo}/issues?state=all&per_page=100" --paginate --jq '.[] | select(.pull_request | not) | {number, title, state, state_reason, labels: [.labels[].name], parent: (.parent_issue_url // "" | split("/") | last), blocked_total: .issue_dependencies_summary.total_blocked_by}'
gh api "repos/{owner}/{repo}/pulls?state=open&per_page=100" --jq '.[] | {number, head: .head.ref, refs: ([.body // "" | scan("(?i)(?:closes|fixes|refs) #([0-9]+)") | .[0]])}'
gh api "repos/{owner}/{repo}/issues?labels=sprint-log&state=all&per_page=100" --jq '.[] | {number, title, state, body}'
```

ラベルの絞り込み（`labels=a,b`）は AND になるので、全件を引いて手元で分ける。
今のスプリントは、開いている記録の Issue（`sprint-log`）。2つ開いていれば、番号の大きいほうを今のスプリントとし、`sprint-plan` が途中で止まっていることを点検の結果に書く。
`blocked_total` が 0 でない開いた Issue だけ、`gh api repos/{owner}/{repo}/issues/<番号>/dependencies/blocked_by --jq '[.[] | {number, state, labels: [.labels[].name]}]'` で前に要るものを引く。
`gh` を1回ずつ打つのが多くなるときは、Python のスクリプトをスクラッチパッドに書き、`subprocess` で `gh` を呼んで JSON に落とす。

### 2. 点検する

今のスプリントについて、次を出す。数え方は `docs/development.md` の「スプリントとポイント」に従う。開いている記録の Issue が無ければ、「スプリントは計画されていない」と書き、`sprint-plan` を推して手順 3 へ進む。

| 見るもの | 出し方 | 人に勧めること |
| --- | --- | --- |
| 進み具合 | 計画の済み ÷ 計画、途中で足した分の済み、残りの日数 | 残りの計画のポイントが、残りの日数で直近のベロシティの割合を超えるなら、外す候補（作業中でないもの）を挙げる |
| 受け入れ待ち | 件数とポイント | 計画の 3 割を超えたら、`sprint-review` を先に行う |
| 待ち | スプリントの Issue のうち、開いていて `status:accepting` の無い前に要るものを持つもの | 前に要るものがスプリントの外なら、先に入れるか、待つ側を外すかを人が決める |
| 作業中と上限 | 作業中の数 / 記録の Issue の作業中の上限 | 上限に達していれば、着手を足さず、レビュー中と受け入れ待ちを先に片付ける |
| スプリントの外の作業 | `sprint:<番号>` の無い作業中かレビュー中の Issue | 途中で足すかを人が決める |

勧めることは出すだけにし、ラベルは付け外ししない。

### 3. 図を直す

Artifact のツールがある手元のセッションでだけ行う。無ければ飛ばし、飛ばしたことを報告する。

#### 3-1. 最新の版を取る

`Artifact` の `action: "read"` に URL を渡して読み、続けて `path: "index.html"` でも読む。前者は出し直しに要る読み取りで、後者がスクラッチパッドに保存するページのファイルを直す。
ほかのセッションも出し直すので、直す前に必ず最新の版を取り直す。出し直しが新しい版との衝突で断られたら、その版を取り直して直しを重ねる。

#### 3-2. ページを直す

ページの JS は次に分かれる。

- `ROWS`: Issue の番号から行へ。`s`（状態）、`t`（題）、`lanes`（作る場所の列）、`deps`（前に要るもの）、`note`、`tags`、`pt`（ポイント）、`sprint`（今のスプリントなら `true`）
- `SECTIONS`: ストーリーの並び。`kind: "story"` は `n`（ストーリーの番号）、`title`、`accept`（受け入れ条件）、`epic`、`epicName`（一本道でないエピックの名前）、`base`（土台）、`closed`、`rows`（タスクの番号を作る順に。タスクの無いストーリーは自分の番号）を持つ。ほかに `epics`（まだ分けていないエピック、`FEATURE_EPICS`）、`human`（人が確かめること）、`other`（見本）
- `SPRINT`: スプリントの節。`current` と `history` を持つ

次の決まりで直す。

- `s` は推測せず GitHub から読む（`docs/development.md` の「Issue の状態」）。閉じていれば `done`、開いていて `status:accepting` が付いていれば `accept`（マージ済みで人の受け入れを待つ。開いた PR があっても `accept`。`done` とは別の印で出す）、開いた PR（ブランチ名の `<番号>-` の先頭か、本文の `Refs` で引く。決まりの前に立てた PR のために `Closes` も拾う）があれば `review`、`status:in-progress` なら `wip`（`status:refining` と両方あっても `wip`）、`status:refining` なら `refining`、どれでもなければ `todo`。開いた PR はブランチ名の先頭の番号で引く
- 閉じた Issue を `done` にする前に、`state_reason` が `not_planned`（重複や対応しない）でないかを確かめる。そうなら図から外す
- スプリントの記録の Issue（`sprint-log`）は作業ではないので、`ROWS` にも `doneIssues` にも入れず、`SPRINT` にだけ使う
- PR を出した Issue は、`note` を「PR #nn」で始める。ページが番号を取って列のブロックに出す
- 開いている Issue の `deps` は、GitHub の依存関係（手順 1）に合わせる。閉じた Issue の `deps` は残す。`status:accepting` の前提も外さずに `deps` へ残す（何を待っていたかの記録を消さないため）。「待ち」と待っている番号はページが `deps` から出し、`s` が `accept` の前提は待ちに数えない。手で書かない
- `lanes` は `area:` のラベルとは別に、Issue の中身から作る場所（見本、画面、運用者、API、DB、定期処理、基盤、文書）を割り当てる
- `pt` は `pt:` のラベルの数。`sprint` は今のスプリントの `sprint:<番号>` が付いていれば `true`。ページは今のスプリントの行に印とポイントを出す
- 新しいストーリー（`story` のラベル）は、`n` を付けて `SECTIONS` に足す。エピックをストーリーに分けたら、`FEATURE_EPICS` から抜き、ストーリーを作る順（並べる回の順）に足す
- ストーリーの Issue が閉じたら `closed: true` を付ける。付いていないと、子のタスクがすべて `done` か `accept` のストーリーは「受け入れ待ち」として一番上の「あなたの番」に出る（ストーリーには `accept` を付けない。子から決まる）
- `SECTIONS` の並びは作る順のまま、手で動かさない。タスクがすべて `done` か `accept` のストーリーは、ページが畳んで一番下にまとめる
- 図に載せない閉じた chore は `doneIssues` に足す
- 人が確かめること、行うこと（`human`、#92〜#96 など）は、「次に着手するもの」に混ぜない
- `SPRINT.current` は、今のスプリントの `n`（番号）、`from` と `to`（期間）、`goal`、`wip`（作業中の数）と `wipLimit`（上限）、`planned`、`plannedDone`、`added`、`addedDone`、`accepting`（ポイント）を持つ。数は手順 2 と同じ。開いている記録の Issue が無ければ `null` にする
- `SPRINT.history` は、閉じた記録の Issue ごとの `{ n, planned, velocity }` を古い順に持つ。締めのコメント（`## 締め` で始まる）の表の「計画」の行と `ベロシティ:` の行から読む。締めのコメントの無い記録は飛ばす
- `SPRINT` が無い版のページには、「次に着手するもの」の下にスプリントの節を足す。`current` があれば、題（番号、期間、ゴール）、計画の済み ÷ 計画の棒（受け入れ待ちの分は `accept` と同じ色で棒に重ねる）、途中で足した分と作業中 / 上限の1行を出し、`history` があれば、スプリントごとのベロシティの棒を並べる。`current` が `null` なら「スプリントは計画されていない」と出す。色はページにある状態の色を使い、新しい色を足さない
- 導入文に済んだ経緯を書き足さない。依存の矢印は、見づらいので描かない

#### 3-3. 出し直す

足元の日付（`asof`）を今日に直す。ページの `<script>` の中身をスクラッチパッドのファイルに抜き出して（Python で `re.search(r"<script>(.*?)</script>", html, re.S)`）`node --check` で構文を確かめてから、同じファイルのパスと URL で出し直す。

### 4. 着手を選ぶかを聞く

`AskUserQuestion` で、続けて `backlog-pick` で着手を選ぶかを聞く。作業中が上限に達しているか、受け入れ待ちが多いときは、推す案を「人の番を先に片付ける」にする。選ぶと答えたら、Skill ツールで `backlog-pick` を起動する。
人に聞けない実行では、聞かずに終える。

## 出力

- 点検の結果（手順 2 の表の各行）と、人に勧めること
- 手元なら、出し直した図の URL。クラウドなら、図を直さなかったこと
