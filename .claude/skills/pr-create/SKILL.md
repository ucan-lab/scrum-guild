---
name: pr-create
description: PRのタイトル・本文・アサイン・レビュワー・ラベル・マイルストーンを差分とリポジトリの慣習から決めてPRを作成する。レビュワーに特に読んでほしい箇所にはインラインレビューコメントを付けて Submit する。self-review が通っていれば確認を取らずに作成する。既にPRがある場合は更新すべき点を提案する。「PR作って」「PR出して」「プルリク作成」「PRの下書き」「スタックPRを出して」などと言われたときに使う。既存PRの概要だけを検証したい場合は pr-description-review、作成後のレビュー指摘とCIへの対応は pr-feedback を使う。
---

# PR Create（PR作成・更新提案）

差分とリポジトリの慣習からPRの全項目を決め、作成する。
レビュワーに読んでほしい箇所は、インラインレビューコメントとして残し、Submit まで行う。このリポジトリでは、PR を作るときのインラインコメントを下書きで止めない（2026-10-25 に決めた）。
作成モードで self-review が通っていれば、ユーザーの承認を取らずに PR を作り、作った後に内容を報告する（Step 4。作業ブランチの PR は後から直せるため）。

## 前提条件

- `gh` CLI が認証済みで使えること（`GH_TOKEN` があればそれを使う。トークンの内容は表示・記録しない）
- カレントブランチがリモートにpush済みであること。未pushなら `git push -u origin <branch>` を提案してから進む
- 対象はGitHubのPR。Backlogのプルリクエストはこのスキルの対象外

## GitHub の操作

PR と Issue の読み書きは `gh api` の REST で行う。クラウドのセッションでは、GraphQL を使う `gh pr` と `gh issue` が 403 で止まるため。
GraphQL でしかできない操作（既存の PENDING review への追記、ファイル単位のコメント）だけは `gh api graphql` を試し、403 なら各節のフォールバックに切り替える。

- `{owner}` `{repo}` `{branch}` は `gh` がカレントのリポジトリとブランチに置き換える。置き換わらずに 404 になるときは、`git remote get-url origin` と `git branch --show-current` から読んで直に書く
- 作業ファイルはスクラッチパッドに置く。スクラッチパッドが無い環境（クラウド）では `/tmp` の下に置く

## Step 0: モード判定

```bash
gh api "repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open" --jq '.[0]' > "<スクラッチパッドの絶対パス>/pr-current.json"
```

- 出力が空か `null` → 作成モード
- PRが返る → 更新モード。返ったJSONを現状として保持する。見るのは `number` `title` `body` `assignees` `requested_reviewers` `labels` `milestone` `draft` `base.ref` `head.ref` `html_url`。付いたレビューは `gh api repos/{owner}/{repo}/pulls/<n>/reviews` で別に取る

どちらのモードでも Step 1〜4 は共通。Step 5 で分岐する。

`gh stack` が入っている環境（手元）で、カレントブランチがスタックに属していれば（`gh stack view --json` が exit 0）、[スタック PR](#スタック-prgh-stack) の手順で進める。

### 作成モードは self-review を先に済ませる

作成モード（スタック PR の `gh stack submit` を含む）では、Step 1 に進む前に Skill ツールで `self-review` を起動する。
このセッションで既に `self-review` を呼んでいれば（会話にその出力があれば）呼び直さない。
ただし、その self-review のあとに差分へ手を入れていれば（self-review 自身の修正以外でコミットが増えた、未コミットの変更がある）もう一度起動する。

差分がドキュメントと設定の Markdown だけ（テスト、lint、レビューエージェントの対象になるコードを含まない）なら、self-review を省いてよい。省いたときは、代わりに行った検証（参照の grep、リンク先の実在の確認など）を本文の確認結果の節に書き、省いたことを Step 4 の提示で一言添える。

self-review でコミットが増えたら、push してから Step 1 に進む。

## スタック PR（gh-stack）

`gh stack` が入っている手元の環境だけで使う。クラウドには無い。

依存し合う層に分けた PR 群は、公式の `gh-stack` スキルでブランチを作り、PR もこのスキルの手順で出す。
ブランチ名、マージ、push の扱いはグローバルの `CLAUDE.md` に従う。

- PR は `gh stack submit --auto` で下書きとして一括作成する。そのあと下から順に1層ずつ、Step 1〜4 と Step 5-B（更新モード）で整える。差分の基点はその PR の `base.ref`（1つ下の層）
- Step 4 の承認は作成モードと同じ扱いにする（self-review が通っていれば取らない）。`gh stack submit` が作った直後の PR を整えるのは作成の続きのため
- 本文の `## 概要` の冒頭に、スタック全体での位置（何層目か、下の層に何を依存しているか）を1行書く

## Step 1: リポジトリの慣習を収集

設定ファイルではなく実績を見る。ラベルは定義だけあって使われていないことが多いため。

```bash
gh api "repos/{owner}/{repo}/pulls?state=closed&per_page=50" --jq '[.[] | select(.merged_at != null)][:20] | map({number, title, labels: [.labels[].name], assignees: [.assignees[].login], requested_reviewers: [.requested_reviewers[].login], milestone: .milestone.title})' > "<スクラッチパッドの絶対パス>/merged.json"
```

付いたレビューは一覧に入らないので、PR ごとに取る。

```bash
gh api "repos/{owner}/{repo}/pulls/<n>/reviews" --jq '[.[].user.login]'
```

あわせて以下を確認する。

```bash
ls .github/PULL_REQUEST_TEMPLATE.md .github/pull_request_template.md .github/PULL_REQUEST_TEMPLATE/ 2>/dev/null
cat .github/CODEOWNERS docs/CODEOWNERS CODEOWNERS 2>/dev/null
gh api user --jq .login
```

収集結果から各項目を決める。

| 項目 | 決め方 |
|---|---|
| タイトル | 直近20件のタイトルの書式に合わせる。Conventional Commits 形式か、日本語か英語か、Issue番号やチケットIDの接頭辞があるか |
| 本文 | テンプレートがあればその見出し構成をそのまま使う。無ければ直近PRの本文構成に合わせる |
| アサイン | `gh api user` で得た自分 |
| レビュワー | `CODEOWNERS` があり、差分のファイルが対象ならそれが正。無ければ直近20件の `requested_reviewers` と、PR ごとに取ったレビューの頻出者。マージ済み PR の `requested_reviewers` はレビューが済むと外れて空になることが多いため、レビューも合わせて数える。自分は除く。候補は `gh api repos/{owner}/{repo}/collaborators/<user>` が 204 を返す人に絞る（実績があっても権限が外れていると依頼できない） |
| ラベル | CONTRIBUTING.md や CLAUDE.md にラベルの付け方が書いてあれば、それに従って `gh api repos/{owner}/{repo}/labels --paginate --jq '.[].name'` にあるラベルから選ぶ（ラベルを入れ直した直後は実績に出ないため）。書いてなければ直近20件に実際に出たラベルの中から選び、実績が0件なら「使われていない」と判断してスキップ。どちらでも新規ラベルは作らない |
| マイルストーン | 実績が0件ならスキップ。ありなら `gh api repos/{owner}/{repo}/milestones --jq '.[] \| {number, title}'` から開いているものを選ぶ |

プロジェクト（Projects）は扱わない。REST に無く、クラウドでは GraphQL を使えないため。付けるなら人が付ける。

`CODEOWNERS` のパターンと差分のファイルを突き合わせるときは、実際にパスを照合する。「このディレクトリならたぶんこの人」と推測しない。

## Step 2: 差分を読む

ベースブランチは以下の優先順で決める。

1. 更新モードなら Step 0 の `base.ref`
2. 作成モードなら `gh api repos/{owner}/{repo} --jq .default_branch`
3. ユーザーが明示していればその指定

```bash
git diff <base>...HEAD --stat
git log <base>..HEAD --oneline
```

`--stat` で規模を見てから本文を読む。`package-lock.json` `composer.lock` `yarn.lock` `pnpm-lock.yaml` 等のロックファイルと生成物はタイトル・本文の判断に不要なのでスキップしてよい。ただしスキップしたことは自分で認識しておく（レビュワーが「この巨大な差分は何？」と思う規模なら本文で一言触れる）。

コミットメッセージだけで本文を書かない。実際のdiffを読む。コミットメッセージが実態とズレていることがある。

### 紐づく Issue を読む

ブランチ名、コミットメッセージ、更新モードなら既存の本文（`Closes #n` 等）、ユーザーの指示から Issue 番号を拾う。見つからなければこの節と Step 5-C を飛ばす。

```bash
gh api repos/{owner}/{repo}/issues/<issue> --jq '{number, title, body, state, labels: [.labels[].name], url: .html_url}' > "<スクラッチパッドの絶対パス>/issue.json"
```

本文の未チェックの項目（`- [ ]`）を完了条件として控える。
PR の本文では、`epic` も `story` も付いていない Issue（タスク。`area:` などほかのラベルの有無は問わない）を `Closes #<番号>` で指す。`story` か `epic` のラベルが付いた Issue は `Refs #<番号>` で指し、`Closes` を使わない（理由: ストーリーとエピックは人が受け入れ条件を確かめて閉じる。`docs/development.md` の「Issue の運用」）。

## Step 3: 草案を作る

### タイトル

差分全体が何をしたかを1行で表す。Step 1 で確認した書式に合わせる。
複数の変更が混ざっている場合は、主となる変更をタイトルにし、残りは本文で列挙する。

### 本文

テンプレートがあればその構成を埋める。無い場合の既定構成:

```markdown
## 概要
<何をしたか。なぜしたかが自明でなければ理由も>

## 変更点
- <レビュワーが差分を読む順に並べる>

## 確認方法
<レビュワーが手元で確認する手順。不要なら節ごと省く>
```

差分で画面の見た目か挙動が変わるなら、[evidence.md](evidence.md) の手順で変更前と変更後のスクリーンショットを撮り、`## エビデンス` 節に貼る。動きが変わる画面は GIF で撮る。UI が変わる PR ではこの節を省かない。

self-review で直さなかった CRITICAL と HIGH の指摘があれば、理由と一緒に本文の `## 補足` に書く（テンプレートに補足の節が無ければ末尾に足す）。
会話に self-review の出力が無ければ、直さなかった指摘があるかをユーザーに聞く。

本文を書いたら、書いてから差分と突き合わせて2観点でセルフチェックする。

- 本文に書いたが差分にない記述がないか
- 差分にあるがレビュワーが「これは何？」と思う変更で本文にないものがないか

### メタデータ

Step 1 の表に従って、アサイン・レビュワー・ラベル・マイルストーンを決める。
使われていないと判断した項目は候補に出さない。「マイルストーンは未使用のためスキップ」と一言添える。

### Issue の完了条件のチェック案

Step 2 で控えた未チェックの項目ごとに、この PR で満たしたかを判定する。
会話に self-review の完了条件ごとの充足状況があればそれを使い、無ければ差分と突き合わせて判定する。

- 差分のどこで満たしたかを示せる項目だけをチェック対象にする
- 本番での確認、他の PR や Issue に残る作業、レビュワーやお客さんの判断待ちの項目はチェックしない（マージ前に人が確かめる余地を残すため）
- 既にチェックされている項目は外さない

### インラインコメント候補

レビュワーに特に読んでほしい箇所だけに絞る。差分の解説を全行に付けない。付ける価値があるのは次のような箇所。

- 意図的に選んだ実装で、読み手が「なぜこうした？」と思いそうな箇所
- 既存の書き方から外れている箇所と、その理由
- レビュワーに判断してほしい箇所（この方針でいいか、命名が適切か）
- 影響範囲が差分の見た目より広い箇所

各候補は `path` / `line` / 本文の3点で持つ。`line` は差分の右側（変更後）の行番号。

## Step 4: ユーザー承認

作成モードで self-review が通っていれば、承認を取らずに Step 5-A に進む。下の提示内容は Step 7 の報告に回す。
通ったとみなすのは、このセッションで self-review を実行し、直さなかった CRITICAL と HIGH の指摘が残っていないとき。`finding-verifier` が `反証` を返した指摘は、残った指摘に数えない（判定と直さない理由は本文の `## 補足` に書く）。次のときは承認を取る。

- self-review を省いた（Markdown だけの差分）
- 直さなかった CRITICAL か HIGH の指摘がある（`finding-verifier` が `維持` を返したまま直さなかったものを含む）
- 更新モード（人が設定した既存のPRを書き換えるため）

承認を取るときは、タイトル・本文・メタデータ・Issue のチェック案・インラインコメント候補をまとめて1回で提示する。項目ごとに小刻みに聞かない。
インラインコメントはこの承認で Submit まで行うことを提示に書く。
チェック案は、チェックする項目と満たした差分の箇所、チェックしない項目とその理由を並べる。

提示（承認を取らないときは作成）の直前に `git fetch origin` し、ブランチがベースの最新に乗っているかを添える（ベースの SHA、遅れていればそのコミット数）。添えないと、乗っていても取り込みを頼まれ、確認の往復が増える。遅れていれば `sync-base` で取り込む。

選択式の質問は `AskUserQuestion` で出す。

エビデンスを撮った場合は、装飾済みの画像のパスも一緒に示す。

更新モードでは、Step 0 で取得した現状と草案を突き合わせ、ズレている項目だけを提案する。一致している項目は提案に並べない。全項目が一致していれば「更新不要」と1行報告し、Issue のチェック案があれば Step 5-C だけ行ってから Step 9 に進む。

更新モードで既にレビュワーのコメントが付いている場合（Step 0 で取ったレビューが空でない）は、タイトル・本文の変更が会話の文脈を壊す旨を添えて承認を取る。

## Step 5-A: 作成モード

PR を作り、番号と URL をファイルに残す。ターミナル出力の見た目からPR番号を読み取らない。

```bash
gh api repos/{owner}/{repo}/pulls \
  -f base=<base> \
  -f head=<branch> \
  -f title="<title>" \
  -F body=@"<スクラッチパッドの絶対パス>/pr-body.md" \
  --jq '{number, url: .html_url}' > "<スクラッチパッドの絶対パス>/pr.json"
```

本文は必ずファイルに書き出して `-F body=@<ファイル>` で渡す。シェルに直接埋めると改行とエスケープが壊れる。

メタデータは作成後に付ける。決めなかった項目は呼ばない。空文字を渡さない。

```bash
gh api repos/{owner}/{repo}/issues/<n>/assignees -f "assignees[]=<self>"
gh api repos/{owner}/{repo}/issues/<n>/labels -f "labels[]=<label1>" -f "labels[]=<label2>"
gh api -X PATCH repos/{owner}/{repo}/issues/<n> -F milestone=<マイルストーンの number>
gh api repos/{owner}/{repo}/pulls/<n>/requested_reviewers -f "reviewers[]=<user1>" -f "reviewers[]=<user2>"
```

エビデンスがあれば、作成後に [evidence.md](evidence.md) の 6 で画像を付ける。

レビュワーを指定したら、付いたかを確かめる。

```bash
gh api repos/{owner}/{repo}/pulls/<n>/requested_reviewers --jq '[.users[].login]'
```

指定した人が無ければ、依頼のときに返ったエラーをユーザーに伝える。

## Step 5-B: 更新モード

変更のある項目だけを渡す。

```bash
gh api -X PATCH repos/{owner}/{repo}/pulls/<n> -f title="<title>" -F body=@"<スクラッチパッドの絶対パス>/pr-body.md"
gh api repos/{owner}/{repo}/issues/<n>/labels -f "labels[]=<label>"
gh api repos/{owner}/{repo}/pulls/<n>/requested_reviewers -f "reviewers[]=<user>"
gh api repos/{owner}/{repo}/issues/<n>/assignees -f "assignees[]=<user>"
```

ラベル、レビュワー、アサインの `DELETE` と、ラベルを丸ごと置き換える `PUT` は使わない。人が意図して設定したものを消さないため。外す必要があると判断した場合は、実行せずユーザーに提案だけする。

本文を書き換えるときは、既存の構造と文体を維持し、ズレている箇所だけを最小限直す。正確な記述は一字一句変えない。本文にあるが差分にない記述は、即削除せず「（本PRの対象外）」等の注釈を優先する。

## Step 5-C: Issue の完了条件にチェックを付ける

どちらのモードでも Step 5-A か 5-B のあとに行う。チェック案（承認を取ったときは承認された案）が無ければこの Step は飛ばす。作成モードでは PR を作れてから行う（PR が無いのに完了扱いにしないため）。

書き換える直前に本文を取り直す。Step 2 で取った本文を使うと、その後に人が書き足した分を上書きで消す。

```bash
gh api repos/{owner}/{repo}/issues/<issue> --jq .body > "<スクラッチパッドの絶対パス>/issue-body.md"
```

チェック案の項目の行だけ `- [ ]` を `- [x]` に置き換える。置き換えは Python で行の完全一致で行い、他の行と空白は一字も変えない。項目の行が見つからなければ（取り直した本文で文言が変わっていれば）その項目は付けずに報告する。

```bash
gh api -X PATCH repos/{owner}/{repo}/issues/<issue> -F body=@"<スクラッチパッドの絶対パス>/issue-body-checked.md"
```

書き換えたあと本文を取り直し、意図した項目だけが `- [x]` に変わったことを確かめる。

## Step 6: インラインコメントを投稿する

インラインコメント候補が無ければこのStepは飛ばす。

いったん PENDING review として作り、ファイル単位のコメントを足してから、最後に Submit する。ファイル単位のコメントは PENDING review にしか足せないため。

### 既存のPENDING reviewを確認する

1人1PRにつきPENDING reviewは1つまで。既にあると新規作成が失敗する。

```bash
gh api "repos/{owner}/{repo}/pulls/<n>/reviews" --jq '.[] | select(.state=="PENDING") | .id'
```

- 空 → 新規作成に進む
- IDが返る → 追記に進む

### 新規作成

リクエストボディはPythonでJSONに書き出す。シェルでJSONを組まない（改行が潰れる）。

```python
import json, pathlib
body = {
    "commit_id": "<head sha>",
    "comments": [
        {"path": "src/foo.ts", "line": 42, "side": "RIGHT", "body": "..."},
    ],
}
pathlib.Path("<スクラッチパッドの絶対パス>/review.json").write_text(
    json.dumps(body, ensure_ascii=False), encoding="utf-8"
)
```

ここでは `event` を含めない。含めるとその場で Submit され、ファイル単位のコメントを足せなくなる。Submit は下の「Submit する」で行う。

```bash
gh api -X POST "repos/{owner}/{repo}/pulls/<n>/reviews" \
  --input "<スクラッチパッドの絶対パス>/review.json" \
  > "<スクラッチパッドの絶対パス>/review-result.json"
```

`commit_id` は `gh api repos/{owner}/{repo}/pulls/<n> --jq .head.sha` で取る。

### 追記（既存のPENDING reviewがある場合）

REST に既存PENDING reviewへのコメント追加エンドポイントは無い。GraphQL の `addPullRequestReviewThread` を使う。
RESTのreview ID（数値）とGraphQLのnode ID（文字列）は別物なので、node IDをGraphQLで取り直す。

```bash
gh api graphql -F owner=<owner> -F repo=<repo> -F number=<n> -F query=@"<スクラッチパッドの絶対パス>/pending.graphql"
```

GraphQLのクエリは必ずファイルに書いて `-F query=@file` で渡す。シェルに直接埋めると `String!` の `!` がエスケープされて壊れる。
403（クラウド）が返ったら、下のフォールバックに切り替える。

### 失敗したときのフォールバック

PENDING reviewの作成・追記が権限やAPIの制約で通らない場合は、諦めてPR本文の末尾に節を足す。

```markdown
## レビューで特に見てほしい点
- `src/foo.ts:42` — <コメント本文>
```

失敗した事実とフォールバックしたことをユーザーに報告する。黙って本文に移し替えない。

### `line` が通らない場合

`line` が差分のハンク外を指していると、リクエスト全体が 422 で失敗する。その候補はファイル単位のコメントに落とす。

REST の新規作成はファイル単位のコメントを受け付けない（`comments` に `subject_type` を入れても 422 になる）。
その候補を `comments` から外して新規作成し、作成後に GraphQL の `addPullRequestReviewThread` で `subjectType: FILE` として足す。
`pullRequestReviewId` には、新規作成の結果の `node_id` を渡す。GraphQL が 403（クラウド）なら、その候補だけ上のフォールバックで本文に移す。

```graphql
mutation($id: ID!, $path: String!, $body: String!) {
  addPullRequestReviewThread(input: {pullRequestReviewId: $id, path: $path, body: $body, subjectType: FILE}) {
    thread { id }
  }
}
```

```bash
gh api graphql -F id=<node_id> -F path=src/foo.ts -F body=@"<本文のファイル>" -F query=@"<スクラッチパッドの絶対パス>/file-comment.graphql"
```

### Submit する

コメントが揃ったら、PENDING review を `COMMENT` で Submit する。`<review_id>` は新規作成の結果の `id`（数値）。

```bash
gh api -X POST "repos/{owner}/{repo}/pulls/<n>/reviews/<review_id>/events" -f event=COMMENT --jq '{state, submitted_at}'
```

`state` が `COMMENTED` になったことを確かめる。`APPROVE` と `REQUEST_CHANGES` は使わない（自分の PR への講評ではなく、読む箇所の案内のため）。

既にあった PENDING review に追記した場合は、このセッションで入れていないコメントが混ざっていないかを確かめてから Submit する。混ざっていれば Submit せずにユーザーに確認する。

## Step 7: 報告

- PRのURL
- 設定した項目（スキップした項目はその理由を一言）
- Issue の完了条件でチェックを付けた項目と、残した項目
- インラインコメントを何件投稿したか（本文に移したものがあればその件数も）
- ブランチがベースの最新に乗っているか（Step 4 で承認を取らなかったとき）

## Step 8: スキルの改善提案

報告まで終えたら、このセッションのやりとりを振り返り、次回このスキルを良くする改善があれば提案する。無ければ「今回反映すべき点は無し」と述べて終える。無理に作らない。

### 1. 材料を集める

草案どおりに作られたとは限らない。実物を取り直して突き合わせる。

```bash
gh api repos/{owner}/{repo}/pulls/<n> --jq '{title, body, labels: [.labels[].name], assignees: [.assignees[].login], requested_reviewers: [.requested_reviewers[].login], milestone: .milestone.title}'
```

- Step 3 の草案と実物の差 — ユーザーが Step 4 の承認時に直した箇所（承認を取った場合）、PR作成後にGitHub上で直した箇所
- 手順でつまずいた箇所 — 失敗したコマンド、返ってきたAPIエラー、判断に迷ってユーザーに聞き返した点

### 2. 改善候補を分類する

| 型 | 例 | 行き先 |
|---|---|---|
| タイトル・本文の書式 | 草案の構成を毎回同じ形に直される | SKILL.md |
| メタデータの決め方 | 実績から選んだラベル・レビュワーが外れる | SKILL.md |
| 手順の不備 | APIの叩き方が違った、フォールバックが必要になった | SKILL.md |
| リポジトリ固有の事実 | このリポジトリのレビュワーは誰、ラベルの運用ルール | `AGENTS.md` か `CLAUDE.md` |
| 環境やツールの落とし穴 | sandbox で失敗したコマンド、`gh` の TLS エラー、SSH の遮断 | グローバルの `CLAUDE.md` の落とし穴の節。既に書いてあれば候補にしない |

単発の事情による変更と、次も再現しそうな癖を区別する。再現しそうなものだけを候補にする。

### 3. 提案のルール

1. 汎用的な改善だけをスキルに入れる。リポジトリ固有の事実はスキルに書かず、`AGENTS.md` か `CLAUDE.md` への追記を提案する
2. 勝手に編集しない。対象ファイル・修正内容・根拠（どのやりとりから導いたか）を示し、承認を得てから `SKILL.md` を編集する
   - 採否は Step 7 の報告とは分けて `AskUserQuestion` で聞く（反映する、見送る）。報告の末尾に文章で置くと、ユーザーの次の依頼に押し流されて回答されないまま終わる
   - このスキルの原本は `ucan-lab/claude-skills` にある。反映したら、原本にも同じ変更が要るかをユーザーに伝える
3. 提案は多くて2件に絞る。並べられると選別のコストがかかる
4. Step 6 でPENDING reviewのAPIが失敗した場合は、実際に通った手順を必ず提案に含める。同じ失敗を次回も繰り返さないため

## Step 9: pr-feedback に引き継ぐ

Step 8 の採否が決まったら、Skill ツールで `pr-feedback` を起動する。CI の結果待ちと、付いたレビュー指摘への対応はそちらで行う。

## 注意事項

- 差分を読まずにコミットメッセージだけでタイトル・本文を書かない
- 存在しないラベル・マイルストーンを新規作成しない。候補が無ければスキップする
- レビュワーを推測で決めない。`CODEOWNERS` か直近PRの実績のどちらかを根拠にする
- PRの言語は直近PRに合わせる。日本語のリポジトリなら日本語で書く
- 承認を取る条件（Step 4）に当たるときは、承認前にPRを作らない
- UI が変わる PR では `## エビデンス` 節を必ず埋める。撮影時の SHA 以降に UI の変更が無ければ撮り直さない
- 既にPRがある場合の本文修正だけが目的なら、手元では `pr-description-review` を使う。こちらの方が保守的に直す
