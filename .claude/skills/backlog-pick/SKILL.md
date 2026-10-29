---
name: backlog-pick
description: 進捗を確かめ、今着手できる Issue を選んで、並べて進めるレーンとセッションに貼るプロンプトを出す。「進捗を確認して」「次は何をやる」「今着手できるもの」「並べて進めたい」と言われたときに使う。1つの Issue を進めるのは increment-build、スプリントのゴールに向けた点検と開発ボードは daily-scrum。
---

# backlog-pick

## 仕事

GitHub の今の状態から着手できる Issue を選び、変えるファイルが重ならないレーンに組んで、人が選んだレーンのプロンプトを出す。
終わりは「人の番のものと着手できるものが一覧になり、人が選んだレーンごとに、貼れるプロンプトが出ている」状態。
このスキルは Issue もコードも書き換えない。
このスキルを使ったセッションは、プロンプトを出して終わる。選んだ Issue の作業（`increment-build`、`backlog-refine`、`backlog-add` の起動、ワークツリーを切る、ラベルを付ける）は、このセッションで始めない。人に聞けない実行でも同じ。状態を引いた結果で会話が膨らんだセッションで作業まで始めると、1つの Issue に使える文脈が減るため。
1つのレーンは1つの Issue を受け持つ。1つのプロンプトに別の Issue を続けない（`docs/development.md` の「並行して作業するときの決まり」）。

## GitHub の操作

`gh api` の REST で読む。クラウドのセッションでは、GraphQL を使う `gh issue` と `gh pr` が 403 で止まるため。
`{owner}` と `{repo}` は `gh` がカレントのリポジトリに置き換える。`gh` は1行に1つで打ち、パイプやリダイレクトでつながない（加工は `--jq` で行う）。
`gh` が無いか認証で失敗するときは、`pr-create/github-mcp.md` に従い、GitHub の MCP ツールで代える（Issue は `list_issues`、親は `issue_read` の `get_parent`、`subs` は `get` の `sub_issues_summary`、`blocked` は `issue_dependency_read` で引く。どれも1件ずつ引くので、時間がかかる）。

## 手順

### 1. 状態を引く

```bash
gh api "repos/{owner}/{repo}/issues?state=open&per_page=100" --paginate --jq '.[] | select(.pull_request | not) | {number, title, labels: [.labels[].name], milestone: .milestone.title, parent: (.parent_issue_url // "" | split("/") | last), blocked: .issue_dependencies_summary.blocked_by, subs: .sub_issues_summary}'
gh api "repos/{owner}/{repo}/pulls?state=open&per_page=100" --jq '.[] | {number, head: .head.ref, refs: ([.body // "" | scan("(?i)(?:closes|fixes|refs) #([0-9]+)") | .[0]])}'
```

`blocked` は、開いている前に要るもの（blocked by）の数で、閉じたものは数えない。受け入れ待ち（`status:accepting`）の前に要るものは、開いているので数に入る。前に要るものは GitHub の依存関係だけを正とし、本文の表から読まない（`backlog-add` が登録のときにつなぐ）。

待ちに数えるのは、開いていて `status:accepting` の無い前に要るものだけ（動作の確認を受け入れでまとめて行い、実装を止めないため。`docs/development.md` の「Issue の運用」）。`blocked > 0` の Issue だけ、次で前に要るものを引き、そのようなものが1つでもあれば待ちとする。

```bash
gh api repos/{owner}/{repo}/issues/<番号>/dependencies/blocked_by --jq '[.[] | select(.state == "open" and (([.labels[].name] | index("status:accepting")) == null)) | .number]'
```

今のスプリントは、開いている記録の Issue（`sprint-log`）で読む。題から番号と期間を、本文から計画の一覧と作業中の上限を取る（`docs/development.md` の「スプリントとポイント」）。無ければスプリントの無い並べ方で進め、出力に `sprint-plan` を推す1行を添える。2つ開いていれば、番号の大きいほうを今のスプリントとし、`sprint-plan` が途中で止まっていることを出力に添える。

```bash
gh api "repos/{owner}/{repo}/issues?labels=sprint-log&state=open" --jq '.[] | {number, title, body}'
```

Issue を指す開いた PR は、ブランチ名の `<番号>-` の先頭か、本文の `Refs #<番号>` で引く。クラウドのセッションのブランチ（`claude/*`）は番号を持たないため。決まりの前に立てた PR は `Closes` で指しているので、`Closes #<番号>` も拾い続ける。

### 2. 分ける

開いている Issue を、上の行から順に当てて1つの組に入れる。状態の読み方は `docs/development.md` の「Issue の状態」。記録の Issue（`sprint-log`）は作業ではないので、どの組にも入れない。

| 組 | 当てはまるもの |
| --- | --- |
| 人の番 | 受け入れ待ち（`status:accepting` が付いた Issue。開いた PR があっても受け入れ待ち。子を持つ `story` と `epic` は、`subs.total > 0` で、開いている子がすべて受け入れ待ち。子を持つ子（エピックの下のストーリー）は、ラベルではなく同じ判定をその子に当てて決める）。開いた PR がある。人が行う Issue（題が「確認:」で始まる、要件を決める、本番やアカウントやドメインの操作） |
| 作業中 | `status:in-progress` |
| 要件整理中 | `status:refining` |
| 待ち | 上の手順で待ちが見つかった（`blocked > 0` で、開いていて `status:accepting` の無い前に要るものがある）、または親（`parent` をたどった先のどれか）が待ち |
| 子を進める | 子を持つ `story` と `epic`。中身は子の Issue が入る組で見る |
| 分ける前 | 子の無い `epic`。`backlog-add` で分けるレーンの候補 |
| 着手できる | 残り。タスクと、子の無い `story` |

待ちの Issue が待っている番号は、上の手順で引いた一覧をそのまま使う。

今のスプリントの `sprint:<番号>` が付いたものを先に、次にマイルストーンが「初版」のものを並べ、ほかは後ろにまとめる。

今のスプリントの進み具合を出す。数え方は `docs/development.md` の「スプリントとポイント」の表に従い、計画の済み ÷ 計画、受け入れ待ち、途中で足した分（とその済み）、作業中 / 上限を出す。計画のポイントは記録の Issue の本文の値を使う。

閉じた Issue は手順 1 の一覧に出ないので、今のスプリントの分だけ引く。計画の一覧にあってここに出ない Issue（スプリントから外したもの）は、`gh api repos/{owner}/{repo}/issues/<番号> --jq '{state, state_reason}'` で1件ずつ引き、`completed` で閉じていれば計画の済み、ほかは取り下げに数える。ここに出た Issue も、`not_planned` か `duplicate` で閉じていれば取り下げに数える。

```bash
gh api "repos/{owner}/{repo}/issues?labels=sprint:<番号>&state=all&per_page=100" --paginate --jq '.[] | select(.pull_request | not) | {number, state, state_reason, labels: [.labels[].name]}'
```

### 3. レーンを組む

着手できるものを、作る順に並べる。作る順は親のサブ Issue の並び（`gh api repos/{owner}/{repo}/issues/<親>/sub_issues --jq '.[].number'`）で読む。

並べてよいかは `docs/development.md` の「並行して作業するときの決まり」で決める。各 Issue の「やること」（`gh api repos/{owner}/{repo}/issues/<番号> --jq .body`）から変えるファイルを読み、作業中とレビュー中の Issue とも比べる。

- 共通の層を2つが形を変えるなら並べない
- `migration` の付いた Issue は、作業中とレビュー中を合わせて1本まで
- 1つのレーン（1つのセッション）が受け持つ Issue は1つ。続けて進めたい Issue は別のレーンにするか、先のレーンの PR が閉じた後の次の `backlog-pick` に回す
- `needs-human` の Issue は、人が差分を読む量を添える
- 作業中の数（`docs/development.md` の「スプリントとポイント」の数え方。作業中とレビュー中で、受け入れ待ちを除く）に、新しく始める Issue を足した数が、記録の Issue の作業中の上限を超えないようにする。上限に達していれば、レーンを足さず、人の番を先に片付ける案を推す。プロンプトを出してから貼るまでの間に、ほかのセッションが着手することがあるので、`increment-build` が着手の前にもう一度確かめる

人の番が多いときは、着手を足すより人の番を先に片付ける案を推す。並べるほど、人が読む PR が増えるため。
スプリントの外の Issue を着手できるものに選ぶときは、レーンの案に「スプリントの外」と添える。足すと途中で足した分に数えるため、人がスプリントに入れると答えたときだけ、`sprint:<番号>` を付けるよう人に頼む（このスキルは Issue を書き換えない）。
次に来るのが分ける前のエピックなら、`backlog-add` で分けるレーンを1本入れる。

同じ本文から、各 Issue を何で始めるかを決める。本文のどの節にあるかは問わず、中身で見る。次のどれかがあれば `backlog-refine` で始め、無ければ `increment-build` で始める。

- 「着手時に決める」「着手の前に詰める」のように、決めることを先送りした書き方
- 比べた案が並んでいて、採る案が決まっていない
- 受け入れ条件（完了条件）が無いか、中身が空
- 人が判断する（人の好みか仕様の判断が要る）と書かれ、まだ決まっていない

次のものは数えない。

- 調べるか、本文に書いた判定の基準（例: 計測して速いほうを採る）で決められるもの。「要確かめ」の項目もこれに当たる。`increment-build` が調べて決め、伝える
- 「着手前に詰めたこと」の節で既に決まった分岐（節を足しても、元の先送りの書き方は本文に残るため）

本文に無い難所は、`increment-build` が途中で `backlog-refine` に入って詰める。ここで分けるのは、人と決める分岐が本文の時点で分かっている Issue を、最初から人と詰めるセッションとして始めるため。
`backlog-refine` は人に聞くのが本体なので、人に聞けない実行では `backlog-refine` で始めるレーンを出さず、`increment-build` で始める（`increment-build` は前提を置いて Issue と PR に書く）。

`backlog-refine` で始める Issue は、分岐のどちらを採るかで変えるファイルが変わることがある。分岐ごとに変わりうるファイルを合わせて重なりを見る。読めなければ、プロンプトの「重なりうるファイル」に「未定（詰めた後に確かめ直す）」と書く。

### 4. 聞く

`AskUserQuestion` で、レーンの組み合わせ（推す案を先頭に）を聞く。どのレーンも新しいセッションで始める。
人に聞けない実行では、推す案を選んだものとしてプロンプトまで出す。

### 5. プロンプトを出す

人が選んだレーンごとに、新しいセッションに貼るプロンプトをコードブロックで出す。手元の開発用のサーバーのポートはワークツリーの名前から決まるので、プロンプトに値は載せない（`docs/development.md` の「ポート」）。本物の OAuth のログインを確かめる Issue だけ、プロンプトに「ワークツリーの `.dev-port-offset` に 0 を書く」と添える（オフセット 0 の 5173 と 8787 でしかログインが通らない。並行するレーンにオフセット 0 を使うものがあれば、同時には確かめられない）。

コードブロックの上に、手順 3 でそのスキルを選んだ理由を、Issue ごとに1行添える。当たった条件か、どの条件にも当たらなかったことを書く（例: `理由: #376 は本文に「着手時に backlog-refine で決める」とあり、受ける口の案が決まっていない`、`理由: #373 は4つの条件のどれにも当たらない。採る案と受け入れ条件が本文で決まっている`）。人が貼る前に、判定が合っているかを確かめられるようにするため。

`increment-build` で始めるレーン:

```text
/increment-build <番号>
並行: #<相手の番号>（<相手が変えるもの>）。重なりうるファイル: <パス、無ければ「なし」>
```

`backlog-refine` で始めるレーン:

```text
/backlog-refine <番号>
<決まっていない分岐（本文から読んだもの）>を詰めて Issue に記録する。詰め終えたら同じセッションで /increment-build <番号>
並行: #<相手の番号>（<相手が変えるもの>）。重なりうるファイル: <パス、無ければ「なし」>
```

`backlog-refine` から `increment-build` へ続けるのは同じ Issue なので、1つのレーンのままでよい。別の Issue を「終えたら同じセッションで」と続けない。

分けるレーンは `backlog-add で #<番号> をストーリーとタスクに分けて` とする。1つのレーンで分けるエピックは1つ。
プロンプトを出したら終える。Skill ツールで `increment-build`、`backlog-refine`、`backlog-add` を起動しない。

## 出力

- 今のスプリントの進み具合の1行（例 `スプリント 3（2026-11-05〜2026-11-11）: 計画の済み 8/21 pt、受け入れ待ち 5 pt、途中で足した分 2 pt（済み 1 pt）、作業中 3/4`）。スプリントが無ければ `sprint-plan` を推す1行
- 人の番（受け入れ待ちを含む）、作業中とレビュー中、着手できるもの、待ち（待っている番号）の短い一覧
- レーンの案と、選ばれたレーンのプロンプト（1つのレーンに1つの Issue）。プロンプトごとに、`increment-build` か `backlog-refine` を選んだ理由を1行
- 着手できるものが無ければ、そう書き、人の番か分けるレーンを推す
- 手元のセッションなら、開発ボードを出し直すかを添える（直すのは `daily-scrum` で、このセッションでは直さない）

## 止まる条件

- `gh api` が失敗し、MCP ツールでも代えられない（`issue_dependency_read` が出ないときを含む）。失敗したコマンドと応答を出す
