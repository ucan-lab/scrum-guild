---
name: sprint-plan
description: 週に1回、今のスプリントを締め（済み、受け入れ待ち、途中で足した分、持ち越し、ベロシティを記録の Issue に残す）、次のスプリントに入れる Issue とポイント、ゴール、同時に作業中にする数の上限を人と決めて、ラベルと記録の Issue を作る。「スプリントを計画したい」「スプリントを締めて」「次のスプリント」「/sprint-plan」と言われたときに使う。受け入れは sprint-review、スプリントの中で着手するものを選ぶのは backlog-pick。
---

# sprint-plan

## 仕事

今のスプリントを締め、次のスプリントの約束を人と決めて GitHub に書く。決まりは `docs/development.md` の「スプリントとポイント」。
終わりは「前の記録の Issue に締めのコメントが付いて閉じ、次の `sprint:<番号>` のラベルと記録の Issue ができ、選んだ Issue に `sprint:<番号>` と `pt:` が付いている」状態。
何を入れるかとポイントを決めるのは人で、セッションは数を出し、案を置き、人の答えを GitHub に写す。

## 絶対にやらないこと

- 人の答えを待たずにラベルを付け外ししない。記録の Issue も作らない（理由: スプリントの約束は人が決める。人に聞けない実行では止まる）
- 記録の Issue のほかに Issue を閉じない。閉じるのは受け入れで、`sprint-review` が受け持つ
- スプリントの間に `pt:` を変えない。締めで持ち越す Issue の `pt:` もそのまま使う（理由: 変えると計画と済みの基準がずれる）
- 子を持つストーリーとエピックに `sprint:<番号>` と `pt:` を付けない（理由: 子と二重に数える）

## GitHub の操作

`gh api` の REST で読み書きする。クラウドのセッションでは、GraphQL を使う `gh issue` が 403 で止まるため。
`{owner}` と `{repo}` は `gh` がカレントのリポジトリに置き換える。`gh` は1行に1つで打ち、パイプやリダイレクトでつながない（加工は `--jq` で行う）。
`gh` が無いか認証で失敗するときは、`pr-create/github-mcp.md` に従い、GitHub の MCP ツールで代える。ラベルを作る MCP のツールが無ければ、ラベルの作成だけ人に頼む。
作業ファイルはスクラッチパッドに置く。スクラッチパッドが無い環境では `/tmp` の下に置く。
ラベルの名前の `:` は、パスに入れるときだけ `%3A` にする（`issues/<番号>/labels/sprint%3A<番号>`）。

## 手順

### 1. 今のスプリントを引く

```bash
gh api "repos/{owner}/{repo}/issues?labels=sprint-log&state=open" --jq '.[] | {number, title, body}'
```

- 無ければ最初のスプリント。手順 4 へ進み、番号は 1 にする（閉じた記録の Issue があれば、その最大の番号の次）
- 2つ以上あれば止まり、人にどれが今のスプリントかを確かめる
- 1つなら、題から番号と期間、本文から計画の一覧と作業中の上限を読む。今日が終了日より前なら、`AskUserQuestion` で今締めるか（推す案は「終了日まで待つ」）を聞く

今のスプリントの Issue を引く。

```bash
gh api "repos/{owner}/{repo}/issues?labels=sprint:<番号>&state=all&per_page=100" --paginate --jq '.[] | select(.pull_request | not) | {number, title, state, state_reason, labels: [.labels[].name]}'
```

### 2. 受け入れ待ちを示す

今のスプリントの Issue のうち、開いていて `status:accepting` の付いたものの件数とポイントを出す。
1件以上あれば、`AskUserQuestion` で先に `sprint-review` を行うかを聞く。推す案は「先に `sprint-review` を行う」。済みに数えるのは受け入れで閉じた Issue だけなので、受け入れを後に回すと実装が終わっていてもベロシティに入らないため。
行うと答えたら、Skill ツールで `sprint-review` を起動し、終わってから手順 1 の Issue を引き直す。

### 3. 締めの数を出す

手順 1 で引いた Issue から、次の数を出す。ポイントは `pt:` のラベルの数で、無いものは 0 として数え、件数を別に添える。

| 数 | 当てはまるもの |
| --- | --- |
| 計画 | 記録の Issue の本文の計画の一覧にある Issue |
| 済み | 閉じていて `state_reason` が `completed` の Issue |
| 受け入れ待ち | 開いていて `status:accepting` の付いた Issue |
| 途中で足した分 | `sprint:<番号>` が付いていて、計画の一覧に無い Issue |
| 持ち越し | 開いている Issue（受け入れ待ちを含む） |
| ベロシティ | 済みのポイントの合計 |

`not_planned` で閉じた Issue は、どの数にも入れず、件数だけを添える。
直近のベロシティは、閉じた記録の Issue の締めのコメントから読む（手順 6 の形）。

```bash
gh api "repos/{owner}/{repo}/issues?labels=sprint-log&state=closed&per_page=3&sort=created&direction=desc" --jq '.[] | {number, title}'
gh api "repos/{owner}/{repo}/issues/<記録の番号>/comments" --jq '.[] | select(.body | startswith("## 締め")) | .body'
```

### 4. 候補を並べる

次の順で候補を並べ、表にして見せる（番号、題、ポイント、入れる理由）。

1. 持ち越し（手順 3）。受け入れ待ちのものは作業が無いので入れる案にし、人が受け入れで閉じれば済みに入る
2. `backlog-pick` の手順 1 と 2 の分け方で「着手できる」に入る Issue。マイルストーン「初版」を先に、親のサブ Issue の並び（作る順）で並べる
3. 「待ち」の Issue のうち、待っている前に要るものがすべて候補に入るもの

`sprint-log` の Issue、子を持つストーリーとエピック、人が行う Issue（題が「確認:」で始まる、要件を決める、本番やアカウントやドメインの操作）は候補に入れない。

`pt:` の無い候補は、本文の「やること」と完了条件から見積もりの案（1、2、3、5、8）を置き、理由を1行添える。8 を超えると見たものは候補から外し、`backlog-add` で分ける案にする。

合計の案は、直近3スプリントのベロシティの平均（3つに満たないときはあるだけ。最初のスプリントは比べるものが無いので、受け入れ待ちを除いて 20 ポイント前後）を目安に、候補の上から切る。

### 5. 人と決める

`AskUserQuestion` で次を聞く。候補が多く選択肢に並ばないので、選択肢は案のまとまりにし、細かい直しは「Other」のメモで受ける。

- 入れる Issue とポイント: 推す案（手順 4 の切り方、番号と合計を書く）、持ち越しだけ、の2つ。番号の足し引きとポイントの直しはメモで受ける
- ゴール: 入れる Issue から1文の案を置く
- 同時に作業中にする数の上限: 推す案は 4（`backlog-pick` は1つのセッションに2つまで受け持たせ、レーンを2本並べると4つになるため）
- 持ち越さない開いた Issue があれば、`sprint:<番号>` を外してバックログに戻すか

人に聞けない実行では、ここで止まり、案だけを出す。

### 6. GitHub に書く

人の答えのとおりに、次の順で書く。前の記録を最後に閉じるのは、途中で落ちても今のスプリントが分からなくならないため。

1. 次の記録の Issue を作る。本文はスクラッチパッドのファイルに書いてから渡す

   ```bash
   gh api repos/{owner}/{repo}/issues -f title="スプリント <番号>（<開始日>〜<終了日>）" -F body=@<file> -f 'labels[]=sprint-log' --jq '{number, url: .html_url}'
   ```

   本文の形:

   ```markdown
   ## ゴール

   <1文>

   ## 期間

   <開始日>〜<終了日>

   ## 作業中の上限

   <数>

   ## 計画

   | 番号 | 題 | ポイント |
   | --- | --- | --- |
   | #<番号> | <題> | <数> |
   | 合計 | | <数> |
   ```

2. スプリントのラベルを作る

   ```bash
   gh api repos/{owner}/{repo}/labels -f name="sprint:<番号>" -f color=BFD4F2 -f description="<開始日>〜<終了日> 記録 #<記録の番号>"
   ```

3. 入れる Issue に付ける。`pt:` が無いものには決めたポイントも付ける。持ち越すものは前の `sprint:<番号>` を外してから付ける

   ```bash
   gh api -X POST repos/{owner}/{repo}/issues/<番号>/labels -f 'labels[]=sprint:<番号>' -f 'labels[]=pt:<数>'
   gh api -X DELETE repos/{owner}/{repo}/issues/<番号>/labels/sprint%3A<前の番号>
   ```

   バックログに戻すと答えた Issue は、前の `sprint:<番号>` を外すだけにする。

4. 前の記録の Issue に締めのコメントを足して閉じる（最初のスプリントでは飛ばす）。数は手順 3 で出したもの

   ```markdown
   ## 締め（<日付>）

   | 数 | ポイント | 件数 |
   | --- | --- | --- |
   | 計画 | <数> | <数> |
   | 済み | <数> | <数> |
   | 受け入れ待ち | <数> | <数> |
   | 途中で足した分 | <数> | <数> |
   | 持ち越し | <数> | <数> |

   ベロシティ: <済みのポイント>
   持ち越し先: スプリント <次の番号>（#<番号>、#<番号>）
   バックログに戻した: #<番号>
   ```

   ```bash
   gh api repos/{owner}/{repo}/issues/<前の記録の番号>/comments -F body=@<file> --jq .html_url
   gh api -X PATCH repos/{owner}/{repo}/issues/<前の記録の番号> -f state=closed -f state_reason=completed
   ```

書いた後に、次で付いたラベルを確かめる。

```bash
gh api "repos/{owner}/{repo}/issues?labels=sprint:<番号>&state=all&per_page=100" --paginate --jq '.[] | {number, labels: [.labels[].name]}'
```

## 出力

- 締めた数（計画、済み、受け入れ待ち、途中で足した分、持ち越し、ベロシティ）と、前の記録の Issue の URL
- 次のスプリントのゴール、期間、作業中の上限、入れた Issue とポイントの合計、記録の Issue の URL
- 手元のセッションなら、進捗の図を直すか（`progress-chart`）と、着手を選ぶか（`backlog-pick`）を添える

## 止まる条件

- 開いている記録の Issue が2つ以上ある
- 人に聞けない実行で、手順 5 に来た
- `gh api` が失敗し、MCP ツールでも代えられない。失敗したコマンドと応答を出す
