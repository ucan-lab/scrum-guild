---
name: backlog-pick
description: 進捗を確かめ、今着手できる Issue を選んで、並べて進めるレーンとセッションに貼るプロンプトを出す。「進捗を確認して」「次は何をやる」「今着手できるもの」「並べて進めたい」と言われたときに使う。1つの Issue を進めるのは increment-build、進捗の図を直すのは progress-chart。
---

# backlog-pick

## 仕事

GitHub の今の状態から着手できる Issue を選び、変えるファイルが重ならないレーンに組んで、人が選んだレーンのプロンプトを出す。
終わりは「人の番のものと着手できるものが一覧になり、人が選んだレーンごとに、貼れるプロンプトが出ている」状態。
このスキルは Issue もコードも書き換えない。

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

Issue を指す開いた PR は、ブランチ名の `<番号>-` の先頭か、本文の `Refs #<番号>` で引く。クラウドのセッションのブランチ（`claude/*`）は番号を持たないため。決まりの前に立てた PR は `Closes` で指しているので、`Closes #<番号>` も拾い続ける。

### 2. 分ける

開いている Issue を、上の行から順に当てて1つの組に入れる。状態の読み方は `docs/development.md` の「Issue の状態」。

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

マイルストーンが「初版」のものを先に並べ、ほかは後ろにまとめる。

### 3. レーンを組む

着手できるものを、作る順に並べる。作る順は親のサブ Issue の並び（`gh api repos/{owner}/{repo}/issues/<親>/sub_issues --jq '.[].number'`）で読む。

並べてよいかは `docs/development.md` の「並行して作業するときの決まり」で決める。各 Issue の「やること」（`gh api repos/{owner}/{repo}/issues/<番号> --jq .body`）から変えるファイルを読み、作業中とレビュー中の Issue とも比べる。

- 共通の層を2つが形を変えるなら並べない
- `migration` の付いた Issue は、作業中とレビュー中を合わせて1本まで
- 1つのセッションが受け持つのは2つまで
- `needs-human` の Issue は、人が差分を読む量を添える

人の番が多いときは、着手を足すより人の番を先に片付ける案を推す。並べるほど、人が読む PR が増えるため。
次に来るのが分ける前のエピックなら、`backlog-add` で分けるレーンを1本入れる。

同じ本文から、各 Issue を何で始めるかを決める。次のどれかがあれば `backlog-refine` で始め、無ければ `increment-build` で始める。

- 「着手時に決める」「着手の前に詰める」のように、決めることを先送りした書き方
- 比べた案が並んでいて、採る案が決まっていない
- 受け入れ条件（完了条件）が無いか、中身が空
- 「人が判断すること」が決まらないまま残っている

「要確かめ」の項目は調べれば決められるので、`backlog-refine` で始める理由にしない。本文に無い難所は、`increment-build` が途中で `backlog-refine` に入って詰める。ここで分けるのは、人と決める分岐が本文の時点で分かっている Issue を、最初から人と詰めるセッションとして始めるため。

### 4. 聞く

`AskUserQuestion` で、レーンの組み合わせ（推す案を先頭に）と、このセッションで1つ始めるかを聞く。
人に聞けない実行では、推す案を選んだものとしてプロンプトまで出す。

### 5. プロンプトを出す

人が選んだレーンごとに、新しいセッションに貼るプロンプトをコードブロックで出す。レーンには、手元の開発用のサーバーのポートをずらす `DEV_PORT_OFFSET` を 10 ずつ（0、10、20）割り当てる。既にあるワークツリーで使っている値は避ける。

コードブロックの上に、手順 3 でそのスキルを選んだ理由を1行添える（例: `理由: 本文に「着手時に backlog-refine で決める」とあり、受ける口の案が決まっていない`、`理由: 採る案と受け入れ条件が本文で決まっている`）。人が貼る前に、判定が合っているかを確かめられるようにするため。

`increment-build` で始めるレーン:

```text
/increment-build <番号>
DEV_PORT_OFFSET=<値>。並行: #<相手の番号>（<相手が変えるもの>）。重なりうるファイル: <パス、無ければ「なし」>
<2つ目を受け持つなら>終えたら同じセッションで /increment-build <次の番号>
```

`backlog-refine` で始めるレーン:

```text
/backlog-refine <番号>
<決まっていない分岐（本文から読んだもの）>を詰めて Issue に記録する。詰め終えたら同じセッションで /increment-build <番号>
DEV_PORT_OFFSET=<値>。並行: #<相手の番号>（<相手が変えるもの>）。重なりうるファイル: <パス、無ければ「なし」>
```

分けるレーンは `backlog-add で #<番号> をストーリーとタスクに分けて` とする。
このセッションで始めるレーンがあれば、Skill ツールで、そのレーンのスキル（`increment-build` か `backlog-refine`）を起動する。

## 出力

- 人の番（受け入れ待ちを含む）、作業中とレビュー中、着手できるもの、待ち（待っている番号）の短い一覧
- レーンの案と、選ばれたレーンのプロンプト。プロンプトごとに、`increment-build` か `backlog-refine` を選んだ理由を1行
- 着手できるものが無ければ、そう書き、人の番か分けるレーンを推す
- 手元のセッションなら、進捗の図を直すかを添える（直すのは `progress-chart`）

## 止まる条件

- `gh api` が失敗し、MCP ツールでも代えられない（`issue_dependency_read` が出ないときを含む）。失敗したコマンドと応答を出す
