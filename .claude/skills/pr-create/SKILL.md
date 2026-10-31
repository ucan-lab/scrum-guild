---
name: pr-create
description: PRのタイトル・本文・アサイン・レビュワー・ラベル・マイルストーンを差分とリポジトリの慣習から決めてPRを作成する。レビュワーに特に読んでほしい箇所にはインラインレビューコメントを付けて Submit する。done-check が通っていれば確認を取らずに作成する。既にPRがある場合は更新すべき点を提案する。「PR作って」「PR出して」「プルリク作成」「PRの下書き」「スタックPRを出して」などと言われたときに使う。既存PRの概要だけを検証したい場合は pr-description-review、作成後のレビュー指摘とCIへの対応は pr-feedback を使う。
---

# PR Create（PR作成・更新提案）

差分とリポジトリの慣習からPRの全項目を決め、作成する。
レビュワーに読んでほしい箇所は、インラインレビューコメントとして残し、Submit まで行う。このリポジトリでは、PR を作るときのインラインコメントを下書きで止めない（2026-10-25 に決めた）。
作成モードで done-check が通っていれば、ユーザーの承認を取らずに PR を作り、作った後に内容を報告する（Step 4。作業ブランチの PR は後から直せるため）。
GraphQL が使える手元のセッションでは、本文を書く前にドラフトで PR を作って CI を先に走らせ、本文とインラインコメントは CI の間に入れる（Step 2-B）。ドラフトは、`ci-ok` の成功の後に `pr-feedback` が外す。

## 前提条件

- `gh` CLI が認証済みで使えること（`GH_TOKEN` があればそれを使う。トークンの内容は表示・記録しない）。使えなければ [github-mcp.md](github-mcp.md) に従う
- カレントブランチがリモートにpush済みであること。未pushなら `git push -u origin <branch>` を提案してから進む

## GitHub の操作

PR と Issue の読み書きは `gh api` の REST で行う。クラウドのセッションでは、GraphQL を使う `gh pr` と `gh issue` が 403 で止まるため。
GraphQL でしかできない操作（既存の PENDING review への追記、ファイル単位のコメント）だけは `gh api graphql` を試し、403 なら各節のフォールバックに切り替える。

- `{owner}` `{repo}` `{branch}` は `gh` がカレントのリポジトリとブランチに置き換える。置き換わらずに 404 になるときは、`git remote get-url origin` と `git branch --show-current` から読んで直に書く
- 作業ファイルはスクラッチパッドに置く。スクラッチパッドが無い環境（クラウド）では `/tmp` の下に置く

### `gh` が使えないとき

`gh` が無いか認証に失敗するときは、[github-mcp.md](github-mcp.md) の表のとおり GitHub の MCP ツールで代える。

## Step 0: モード判定

```bash
gh api "repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open" --jq '.[0]' > "<スクラッチパッドの絶対パス>/pr-current.json"
```

- 出力が空か `null` → 作成モード
- PRが返る → 更新モード。返ったJSONを現状として保持する。見るのは `number` `title` `body` `assignees` `requested_reviewers` `labels` `milestone` `draft` `base.ref` `head.ref` `html_url`。付いたレビューは `gh api repos/{owner}/{repo}/pulls/<n>/reviews` で別に取る
- 返った PR が、自分が作者のドラフトで、本文が目印の `<!-- pr-create:draft-first -->` だけ（前後の空白を除く）なら、Step 2-B で作った後に中断したものとみなし、作成モードの続きとして扱う。本文が空なだけのドラフトは、人が意図して作ったものとして更新モードで扱う。Step 2-B の作成は飛ばし、Step 3 から進める（理由: 更新モードでは承認を求め、空の本文を「最小限直す」流れに乗らない）。ドラフトは、引き継いだ `pr-feedback` が外す

どちらのモードでも Step 1〜4 は共通。Step 5 で分岐する。

`gh stack` が入っている環境（手元）で、カレントブランチがスタックに属していれば（`gh stack view --json` が exit 0）、[stack.md](stack.md) の手順で進める。

### 作成モードは done-check を先に済ませる

作成モード（スタック PR の `gh stack submit` を含む）では、Step 1 に進む前に Skill ツールで `done-check` を起動する。
このセッションで既に `done-check` を呼んでいれば（会話にその出力があれば）呼び直さない。
ただし、その done-check のあとに差分へ手を入れていれば（done-check 自身の修正以外でコミットが増えた、未コミットの変更がある）もう一度起動する。

差分がドキュメントと設定の Markdown だけ（テスト、lint、レビューエージェントの対象になるコードを含まない）なら、done-check を省いてよい。省いたときは、代わりに行った検証（参照の grep、リンク先の実在の確認など）を本文の確認結果の節に書き、省いたことを Step 4 の提示で一言添える。
省いたときも、紐づく Issue があれば、Step 1 に進む前に `done-check` の手順 2 の `やらないこと` との突き合わせと判断の一覧だけを自分で行い、その結果を判断の差分として Step 3、Step 4、Step 5-C で使う（理由: 省いた PR だけ点検の行が欠けると、受け入れで点検したかを見分けられない。点検していないものを `触れていない` と書くと、人が点検済みと読む）。以降の「done-check の判断の差分」は、この結果も指す。

done-check でコミットが増えたら、push してから Step 1 に進む。

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

ブランチ名、コミットメッセージ、更新モードなら既存の本文（`Refs #n`。決まりの前に立てた PR は `Closes #n`）、ユーザーの指示から Issue 番号を拾う。見つからなければこの節と Step 5-C を飛ばす。

```bash
gh api repos/{owner}/{repo}/issues/<issue> --jq '{number, title, body, state, labels: [.labels[].name], url: .html_url}' > "<スクラッチパッドの絶対パス>/issue.json"
```

本文の未チェックの項目（`- [ ]`）を完了条件として控える。
PR の本文では、タスクもストーリーもエピックも `Refs #<番号>` で指す。`Refs #<番号> <Issue の題>` の形で行頭に1行ずつ書き（題は読む人のため。`accepting.yml` などは番号だけを拾う）、複数の Issue を指すときも `Refs #1 #2` とまとめずに行を分ける（理由: 番号の無いブランチでは `accepting.yml` が行頭の `Refs #<番号>` だけを拾う）。指す Issue でない番号を、行頭の `Refs` で書かない。GitHub が閉じる合図に読む語（`close`、`closes`、`closed`、`fix`、`fixes`、`fixed`、`resolve`、`resolves`、`resolved` に `#<番号>` が続く形）は、タイトルにも本文にもコミットメッセージにも書かない（理由: マージでは Issue を閉じない。マージで `status:accepting` が付き、人が受け入れ条件を確かめて閉じる。`docs/development.md` の「Issue の運用」）。

## Step 2-B: 手元ではドラフトで先に作る

作成モードで次をすべて満たすときは、Step 3 の前に、本文に目印だけを入れた PR をドラフトで作る（理由: CI が走る間に本文とインラインコメントを書き、待ちを縮める。`ci.yml` はドラフトでも走り、AI レビュー（`ai-review.yml`）はドラフトでは走らないので、本文の無いままレビューされない）。

- done-check が通っていて、Step 4 の承認が要らない。承認が要るときは、承認の前に PR を作らない
- GraphQL が使える（`gh api graphql -f query='{ viewer { login } }'` が 403 で落ちない）。ドラフトを外す `markPullRequestReadyForReview` が GraphQL にしか無いため。使えない（クラウド）ときは飛ばし、Step 5-A で本文の入ったドラフトでない PR を作る
- スタック PR でない（`gh stack submit` が先に作っている。[stack.md](stack.md)）
- 差分で画面の見た目か挙動が変わるなら、変えた画面と状態を開く e2e のテストが差分にある（Step 3 の「本文」の確かめを、ここで先に行う）。無ければ、作る前に `done-check` の手順 5 に戻って足す（理由: 作った後に足して push すると、先に走らせた CI が取り消されて走り直す）

タイトルは Step 3 の「タイトル」の決め方で先に決める。作る直前に、Step 4 と同じくベースの最新に乗っているかを `git fetch origin` で確かめ、遅れていれば `sync-base` で merge して取り込み、通常の push をする。

```bash
gh api repos/{owner}/{repo}/pulls \
  -f base=<base> \
  -f head=<branch> \
  -f title="<title>" \
  -f body='<!-- pr-create:draft-first -->' \
  -F draft=true \
  --jq '{number, url: .html_url, draft}' > "<スクラッチパッドの絶対パス>/pr.json"
```

本文には目印だけを入れる（GitHub の画面には出ない。理由: Step 0 で中断からの再開を、人が空の本文で作ったドラフトと見分ける）。`draft` が `true` で返ったことを確かめる。
以降の Step 5-A は、作らずに本文を書き込む形で行う（Step 5-A の「ドラフトで先に作ったとき」）。本文とタイトルの編集（`edited`）では `ci.yml` は走り直さない。

## Step 3: 草案を作る

### タイトル

差分全体が何をしたかを1行で表す。Step 1 で確認した書式に合わせる。
複数の変更が混ざっている場合は、主となる変更をタイトルにし、残りは本文で列挙する。

### 本文

`.github/pull_request_template.md` の見出しの順に埋める（`Refs`、概要、変更点、確認方法、リスク、戻し方、補足）。各節の書き方はテンプレートのコメントに従い、テンプレートのコメントは本文に残さない（`<!-- pr-create:draft-first -->` など、このスキルが入れる目印は残す）。見出しの構成をこのスキルに写さない（理由: 2か所に持つと片方だけ直ってずれる）。テンプレートが無いリポジトリでは、直近の PR の本文の構成に合わせる。

- 紐づく Issue が無ければ、`Refs` の行ごと消す
- `## リスク` と `## 戻し方` は、文書だけの PR でも空にしない。差分から決める。文書だけなら「低（文書のみ）」「revert」の1行でよい。差分のパスを `.github/labeler.yml` に当て、`needs-human` の領域に触れたら `## リスク` にその領域を書く。revert で戻らないものを含むなら、`## 戻し方` に戻し方を書く。マイグレーションは `docs/operations.md` の「戻し方」の DB の手順を指す。R2 の中身や外への送信など手順が文書に無いものは、戻せない旨と、壊れたときにどう扱うかを書く（手順を作って書かない）
- `## 補足` は、書くことが無ければ節ごと消す
- 更新モード（Step 5-B）では、テンプレートより前に開いた PR に `## リスク` と `## 戻し方` が無いことだけを、直す提案に挙げない。挙げるのは、人が頼んだときと、その PR が revert で戻らない変更を含むときだけ

`increment-build` から実装の担い手（Codex、Claude の `implementer`、Codex が上限に当たって Claude に引き継いだ）を渡されたら、`## 確認方法` に1行で書く（担い手が渡されたときは、この節を省かない）。

本文に画像を載せない。`## エビデンス` 節も書かない（理由: クラウドのセッションは画像を上げられず、本文を書く GitHub の MCP の書き込みは `<img>` を逃がす。[github-mcp.md](github-mcp.md) の注記）。
差分で画面の見た目か挙動が変わるなら、`## 確認方法` に、変えた画面と状態、何が変わったか、それを開く e2e のファイルを書く。変えた画面と状態を開く e2e のテストが無ければ、`done-check` の手順 5 に戻ってテストを足す（PR を作る前、Step 2-B でドラフトを作るときはその前に済ませる。作った後に push すると、先に走らせた CI が取り消されて走り直す）。

done-check で直さなかった CRITICAL と HIGH の指摘があれば、理由と一緒に本文の `## 補足` に書く（本文に `## 補足` が無ければ末尾に作って書く）。
会話に done-check の出力が無ければ、直さなかった指摘があるかをユーザーに聞く。

done-check の判断の差分が、人に聞けない実行（`AskUserQuestion` を出せないか、答える人がいない実行）で `触れた: <パス> — <理由>` なら、その行を本文の `## 補足` にも書く（Step 5-C がラベルを足す。Issue の `やらないこと` に触れたまま PR を出したことを、本文だけを読む人に見せるため）。対話の実行では、done-check の段で止まって人に聞いているので、ここには書かない。

本文を書いたら、書いてから差分と突き合わせて2観点でセルフチェックする。

- 本文に書いたが差分にない記述がないか
- 差分にあるがレビュワーが「これは何？」と思う変更で本文にないものがないか

### メタデータ

Step 1 の表に従って、アサイン・レビュワー・ラベル・マイルストーンを決める。
使われていないと判断した項目は候補に出さない。「マイルストーンは未使用のためスキップ」と一言添える。

### Issue の完了条件のチェック案

Step 2 で控えた未チェックの項目ごとに、この PR で満たしたかを判定する。
会話に done-check の完了条件ごとの充足状況があればそれを使い、無ければ差分と突き合わせて判定する。

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
本文の末尾には、目印の `<!-- pr-create:guide -->` を1行付ける（GitHub の画面には出ない）。`done-check` は、PR の作成者が書いた、この目印の付いたコメントで始まるスレッドを未解決の数に入れない（理由: 案内のコメントも未解決のスレッドになる。作者は人の本人のアカウントなので、作者だけで除くと人が自分で付けた指摘まで見落とす）。

## Step 4: ユーザー承認

作成モードで done-check が通っていれば、承認を取らずに Step 5-A に進む。下の提示内容は Step 7 の報告に回す。
Step 2-B でドラフトを作った後も、作成モードのまま扱う（このセッションが今作った PR で、人が設定した項目が無いため）。
通ったとみなすのは、このセッションで done-check を実行し、直さなかった CRITICAL と HIGH の指摘が残っていないとき。`finding-verifier` が `反証` を返した指摘は、残った指摘に数えない（判定と直さない理由は本文の `## 補足` に書く）。次のときは承認を取る。

- done-check を省いた（Markdown だけの差分）
- 直さなかった CRITICAL か HIGH の指摘がある（`finding-verifier` が `維持` を返したまま直さなかったものを含む）
- 更新モード（人が設定した既存のPRを書き換えるため）

承認を取るときは、タイトル・本文・メタデータ・Issue のチェック案・Issue の本文に足す行（Step 5-C）・インラインコメント候補をまとめて1回で提示する。項目ごとに小刻みに聞かない。
インラインコメントはこの承認で Submit まで行うことを提示に書く。
チェック案は、チェックする項目と満たした差分の箇所、チェックしない項目とその理由を並べる。
Issue の本文に足す行は、足す節ごとに並べる。

提示（承認を取らないときは作成）の直前に `git fetch origin` し、ブランチがベースの最新に乗っているかを添える（ベースの SHA、遅れていればそのコミット数）。添えないと、乗っていても取り込みを頼まれ、確認の往復が増える。遅れていれば `sync-base` で merge して取り込み、通常の push をする。
Step 2-B でドラフトを作ったときは、作る前の確かめで済んだものとし、ここでは取り込まない（理由: ここで `sync-base` すると、先に走らせた CI が取り消されて走り直す。後からベースが進んだ分は、`pr-feedback` と `done-check` が取り込む）。

選択式の質問は `AskUserQuestion` で出す。

更新モードでは、Step 0 で取得した現状と草案を突き合わせ、ズレている項目だけを提案する。一致している項目は提案に並べない。全項目が一致していれば「更新不要」と1行報告し、紐づく Issue があれば Step 5-C と Step 5-D だけ行ってから Step 8 に進む（紐づく Issue が無ければ Step 5-D だけ）。

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

### ドラフトで先に作ったとき

Step 2-B で作った PR には、作らずに本文を書き込む。Step 3 でタイトルを変えたときだけ `title` も渡す。
書き込む本文の末尾にも、目印の `<!-- pr-create:draft-first -->` を1行残す。`pr-feedback` は、この目印のあるドラフトだけを `ci-ok` の後に外す（理由: 別のセッションで再開しても、人が意図してドラフトにした PR と見分けられる）。

```bash
gh api -X PATCH repos/{owner}/{repo}/pulls/<n> \
  -F body=@"<スクラッチパッドの絶対パス>/pr-body.md" \
  --jq '{number, draft, body_length: (.body | length)}'
```

ドラフトは外さない。外すのは `pr-feedback` で、`ci-ok` の成功を待ってから行う（理由: 外すと `ready_for_review` で AI レビューが走る。CI が落ちて直す前に走らせると、直した後に回し直すことになり、サブスクの使用量を余分に使う）。

メタデータは作成後に付ける。決めなかった項目は呼ばない。空文字を渡さない。

```bash
gh api repos/{owner}/{repo}/issues/<n>/assignees -f "assignees[]=<self>"
gh api repos/{owner}/{repo}/issues/<n>/labels -f "labels[]=<label1>" -f "labels[]=<label2>"
gh api -X PATCH repos/{owner}/{repo}/issues/<n> -F milestone=<マイルストーンの number>
gh api repos/{owner}/{repo}/pulls/<n>/requested_reviewers -f "reviewers[]=<user1>" -f "reviewers[]=<user2>"
```

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

更新モードでも本文に画像と `## エビデンス` 節を足さない。
本文に目印の `<!-- pr-create:draft-first -->` があれば、書き換えた本文にも残す（理由: 消すと、`pr-feedback` が `ci-ok` の後にドラフトを外さなくなる）。インラインコメントの目印 `<!-- pr-create:guide -->` も、コメントを直すときに消さない。

ラベル、レビュワー、アサインの `DELETE` と、ラベルを丸ごと置き換える `PUT` は使わない。人が意図して設定したものを消さないため。外す必要があると判断した場合は、実行せずユーザーに提案だけする。

`gh` が使えず MCP で書くとき、本文に `<img` があれば本文は書き戻さない（[github-mcp.md](github-mcp.md) の注記。書き戻すと画像が崩れる）。

本文を書き換えるときは、既存の構造と文体を維持し、ズレている箇所だけを最小限直す。正確な記述は一字一句変えない。本文にあるが差分にない記述は、即削除せず「（本PRの対象外）」等の注釈を優先する。

## Step 5-C: Issue の本文に、完了条件の印と判断の差分を書く

どちらのモードでも Step 5-A か 5-B のあとに行う。紐づく Issue があれば、チェック案が無くても行う（完了条件の印と、本文の3節への行は別の書き込みで、片方が無くてももう片方は要る）。紐づく Issue が無ければ飛ばす。作成モードでは PR を作れてから行う（PR が無いのに完了扱いにしないため。点検の行が PR の番号を持つため）。ドラフトで先に作ったときは、本文を入れた後に行う。

書き換える直前に本文を取り直す。Step 2 で取った本文を使うと、その後に人が書き足した分を上書きで消す。

```bash
gh api repos/{owner}/{repo}/issues/<issue> --jq .body > "<スクラッチパッドの絶対パス>/issue-body.md"
```

取り直した本文に、次の2つを足す。どちらも Python で書き、スクリプトはスクラッチパッドに置く（`.claude/skills/` にスクリプトを足さない）。足す対象が無ければ、書き戻さない。

### 完了条件の印

チェック案（承認を取ったときは承認された案）の項目の行だけ `- [ ]` を `- [x]` に置き換える。置き換えは行の完全一致で行い、他の行と空白は一字も変えない。項目の行が見つからなければ（取り直した本文で文言が変わっていれば）その項目は付けずに報告する。チェック案が無ければ飛ばす。

### 本文の節に行を足す

done-check の判断の差分（会話にある出力）から、次の行を足す。行は `## ` の見出しで節を探し、その節の次の `## ` の直前（最後の節なら本文の末尾）にある、空でない最後の行の後ろに挿す。節に見出ししか無ければ、見出しの後に空行を1つ置いてから挿す（ほかの節の「見出し、空行、行」の形にそろえる）。フェンスのコードブロックの中の `## ` は見出しに数えない。本文の改行（`\r\n` か `\n`）は、足す行にもそのまま使う。ほかの行は、空行も含めて一字も変えない。同じ行が既に節にあれば足さない（更新不要の経路で、同じ点検を2度書かないため）。

- `セッションが置いた前提`: 判断の差分にある、実装中に置いた判断の行（`- <日付> 実装中 <スキル名>: <判断> — <根拠>`）。無ければ足さない
- `やらないこと`: 末尾に点検の行 `- 点検（<日付>、PR #<番号>、<head の短い SHA>）: 触れていない` か `- 点検（<日付>、PR #<番号>、<head の短い SHA>）: 触れた: <パス> — <理由>`。番号は Step 5-A の PR、SHA は `git rev-parse --short HEAD`（push 済みの head）。判断の差分が `節が無い` なら足さない
- `人が決めたこと`: 対話の実行で、done-check が `AskUserQuestion` で聞いた答え。`- <日付> done-check: <論点> → 「<人の答え>」` の形で、選んだ選択肢のラベルと人が添えた注記をそのまま写し、要約しない。「戻す」と答えて直した後は、点検の行を `触れていない` にし、答えは写す。「触れたまま進める」と答えたときは、点検の行の理由に、その答えを `人が決めたこと` に写したことを書く

done-check を省いたときは、Step 0 の「作成モードは done-check を先に済ませる」で自分で行った突き合わせの結果を使う。
取り直した本文に、足す先の節が無い（`やらないこと` を足す前に起票した Issue、`着手前に詰めたこと` の節だけの古い Issue など）ときは、その節には足さず、足せなかった行を報告する。節を新しく作らない。

```bash
gh api -X PATCH repos/{owner}/{repo}/issues/<issue> -F body=@"<スクラッチパッドの絶対パス>/issue-body-checked.md"
```

書き換えたあと本文を取り直し、書き戻す前に取った本文と比べる。違いが、印を付けた行と足した行だけであることを確かめる（削除の行は印を付けた行だけ、追加の行は印を付けた行と足した行だけ）。`gh` の出力の末尾の改行の違いは除く。ほかの行が変わっていれば、取り直した本文からやり直す。

### 人に聞けない実行で触れたとき

done-check の判断の差分が、人に聞けない実行で `触れた: <パス> — <理由>` なら、次の2つを行う。

1. PR の本文の `## 補足` に、その行がある（Step 3 で書いた）ことを確かめる。無ければ PR の本文を取り直し（`gh api "repos/{owner}/{repo}/pulls/<PR の番号>" --jq .body`）、`## 補足` に足して（節が無ければ末尾に作って）書き戻す（`gh api -X PATCH "repos/{owner}/{repo}/pulls/<PR の番号>" --input <JSON のファイル>`。JSON は Python で書く）
2. PR に `needs-human` を足す。付けるだけで外さない（セッションが外すと、人が差分を読まずに済んでしまう）

```bash
gh api -X POST repos/{owner}/{repo}/issues/<PR の番号>/labels -f "labels[]=needs-human"
```

CI の `label` が機械的に付けるのとは別の経路で、パスの規則に当たらない PR にも付く（`docs/development.md` の「マージの判定」）。対話の実行では、done-check が人に聞いて止まっているので、ここでは足さない。

## Step 5-D: セッション名に Issue と PR の番号を入れる

どちらのモードでも、PR の番号が分かったら、セッション名を「PR の後」の形 `#<Issue の番号> PR #<PR の番号> <Issue の題>` にする。紐づく Issue が無ければ `PR #<PR の番号> <PR のタイトル>` にする。形と付け方は `docs/development.md` の「並行して作業するときの決まり」のセッション名に従う（`increment-build` が付けた名前に PR の番号を足す形にそろえる）。

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
- Issue の本文の3節に足した行（`セッションが置いた前提`、`やらないこと`、`人が決めたこと`）と、足せなかった行とその理由。`needs-human` を足したときはそのことと理由
- インラインコメントを何件投稿したか（本文に移したものがあればその件数も）
- ブランチがベースの最新に乗っているか（Step 4 で承認を取らなかったとき）
- UI が変わる PR なら、`## 確認方法` に書いた画面と e2e のファイル。画像は本文に載せないこと
- 付けたセッション名（Step 5-D。付けられなかったときはその理由）
- Step 2-B でドラフトで作ったなら、そのことと、`ci-ok` の成功の後に `pr-feedback` がドラフトを外して AI レビューを走らせること

## Step 8: pr-feedback に引き継ぐ

報告を終えたら、Skill ツールで `pr-feedback` を起動する。CI の結果待ち、ドラフトを外すこと（Step 2-B で作ったとき）、付いたレビュー指摘への対応はそちらで行う。

## 注意事項

- 差分を読まずにコミットメッセージだけでタイトル・本文を書かない
- 存在しないラベル・マイルストーンを新規作成しない。候補が無ければスキップする
- レビュワーを推測で決めない。`CODEOWNERS` か直近PRの実績のどちらかを根拠にする
- PRの言語は直近PRに合わせる。日本語のリポジトリなら日本語で書く
- 承認を取る条件（Step 4）に当たるときは、承認前にPRを作らない
- 本文に画像を載せず、`## エビデンス` 節を書かない。UI が変わる PR では、変えた画面と e2e のファイルを `## 確認方法` に書く
- 既にPRがある場合の本文修正だけが目的なら、手元では `pr-description-review` を使う。こちらの方が保守的に直す
