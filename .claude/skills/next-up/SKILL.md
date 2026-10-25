---
name: next-up
description: 進捗を確かめ、今着手できる Issue を選んで、並べて進めるレーンとセッションに貼るプロンプトを出す。「進捗を確認して」「次は何をやる」「今着手できるもの」「並べて進めたい」と言われたときに使う。1つの Issue を進めるのは issue-run、進捗の図を直すのは progress-chart。
---

# next-up

## 仕事

GitHub の今の状態から着手できる Issue を選び、変えるファイルが重ならないレーンに組んで、人が選んだレーンのプロンプトを出す。
終わりは「人の番のものと着手できるものが一覧になり、人が選んだレーンごとに、貼れるプロンプトが出ている」状態。
このスキルは Issue もコードも書き換えない。

## GitHub の操作

`gh api` の REST で読む。クラウドのセッションでは、GraphQL を使う `gh issue` と `gh pr` が 403 で止まるため。
`{owner}` と `{repo}` は `gh` がカレントのリポジトリに置き換える。

## 手順

### 1. 状態を引く

```bash
gh api "repos/{owner}/{repo}/issues?state=open&per_page=100" --paginate --jq '.[] | select(.pull_request | not) | {number, title, labels: [.labels[].name], milestone: .milestone.title, parent: (.parent_issue_url // "" | split("/") | last), blocked: .issue_dependencies_summary.blocked_by, subs: .sub_issues_summary}'
gh api "repos/{owner}/{repo}/pulls?state=open&per_page=100" --jq '.[] | "\(.number) \(.head.ref) draft=\(.draft)"'
```

手元のセッションなら `git worktree list` も見る。

`blocked` は、開いている前に要るもの（blocked by）の数で、閉じたものは数えない。前に要るものは GitHub の依存関係だけを正とし、本文の表から読まない（`issue-plan` が登録のときにつなぐ）。

### 2. 分ける

開いている Issue を、上の行から順に当てて1つの組に入れる。状態の読み方は `docs/development.md` の「Issue の状態」。

| 組 | 当てはまるもの |
| --- | --- |
| 人の番 | 開いた PR がある（ブランチ名の先頭の番号で引く）。子がすべて閉じた `story` と `epic`（`subs.total > 0` かつ `completed == total`）は受け入れ待ち |
| 作業中 | `status:in-progress` |
| 要件整理中 | `status:refining` |
| 待ち | `blocked > 0`。待っている番号は `gh api repos/{owner}/{repo}/issues/<番号>/dependencies/blocked_by --jq '[.[] \| select(.state == "open") \| .number]'` |
| 子を進める | 子を持つ `story` と `epic`。中身は子の Issue が入る組で見る |
| 分ける前 | 子の無い `epic`。`issue-plan` の書くモードで分けるレーンの候補 |
| 着手できる | 残り。タスクと、子の無い `story` |

マイルストーンが「初版」のものを先に並べ、ほかは後ろにまとめる。

### 3. レーンを組む

着手できるものを、作る順に並べる。作る順は親のサブ Issue の並び（`gh api repos/{owner}/{repo}/issues/<親>/sub_issues --jq '.[].number'`）と、親のエピックの本文の「やること」の表で読む。

並べてよいかは `docs/development.md` の「並行して作業するときの決まり」で決める。各 Issue の「やること」から変えるファイルを読み、作業中とレビュー中の Issue とも比べる。

- 共通の層を2つが形を変えるなら並べない
- `migration` の付いた Issue は、作業中とレビュー中を合わせて1本まで
- 1つのセッションが受け持つのは2つまで
- `needs-human` の Issue は、人が差分を読む量を添える

人の番が多いときは、着手を足すより人の番を先に片付ける案を推す。並べるほど、人が読む PR が増えるため。
次に来るのが分ける前のエピックなら、`issue-plan` で分けるレーンを1本入れる。

### 4. 聞く

`AskUserQuestion` で、レーンの組み合わせ（推す案を先頭に）と、このセッションで1つ始めるかを聞く。

### 5. プロンプトを出す

人が選んだレーンごとに、新しいセッションに貼るプロンプトをコードブロックで出す。

```text
/issue-run <番号>
並行: #<相手の番号>（<相手が変えるもの>）。重なりうるファイル: <パス、無ければ「なし」>
```

分けるレーンは `issue-plan の書くモードで #<番号> をストーリーとタスクに分けて` とする。
このセッションで始めるレーンがあれば、Skill ツールで `issue-run` を起動する。

## 出力

- 人の番、作業中とレビュー中、着手できるもの、待ち（待っている番号）の短い一覧
- レーンの案と、選ばれたレーンのプロンプト
- 進捗の図を直すかは添えるだけにし、直すのは `progress-chart`
