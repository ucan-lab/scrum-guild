---
name: rename-session
description: セッション名を、受け持つ Issue と PR の番号から決まった形で付ける。`backlog-refine`、`increment-build`、`pr-create` が、Issue が決まった後と PR の番号が分かった後に呼ぶ。「セッション名を付けて」「rename-session」と言われたときにも使う。
---

# rename-session

## 仕事

セッション名を、`docs/development.md` の「並行して作業するときの決まり」の形にする。名前を手で打たせない。
終わりは、クラウドなら名前が付いた状態。手元なら、貼れば付く `/rename` 行を出してクリップボードに入れた状態。

## 入力

呼ぶ側が渡す。

- Issue の番号（無いこともある）
- PR の番号（PR を作った後だけ）

渡されない値は、今のブランチ名 `<Issue番号>-<短い名前>` の先頭の数字と、`gh pr list --head <ブランチ> --state all --limit 1 --json number` で引く。

## 手順

### 1. 名前を決める

形は次の3つだけ。題は Issue の題（`gh issue view <番号> --json title --jq .title`）で、PR の後も Issue の題のまま使う。改行と連続する空白は1つの空白に詰め、80 文字を超えたら切る。

- PR の前: `#<Issue の番号> <Issue の題>`
- PR の後: `#<Issue の番号> PR #<PR の番号> <Issue の題>`
- 紐づく Issue の無い PR: `PR #<PR の番号> <PR のタイトル>`

### 2. 付ける

クラウドのセッション（`set_session_title` のツールがある環境）:
`get_session` を `session_id` を渡さずに呼んで今の名前を取り、決めた名前と違うときだけ `set_session_title` で付ける。

手元のセッション:
Claude Code のスキルからは `/rename` を実行できない。決めた名前を使って、次の2つをする。

1. 名前を入れた1行 `/rename <名前>` をスクラッチパッドのファイルに Write し、`pbcopy < <ファイルの絶対パス>` でクリップボードに入れる（名前に引用符やバックスラッシュが入っても壊れないよう、シェルの引数に載せない）
2. 返答の中で、コードスパンに入れた `/rename <名前>` を見せ、「クリップボードに入れた。貼って Enter」と一言添える

同じ名前を同じセッションで2回出さない。呼ぶ側が続けて呼んでも、前回と同じ名前なら何もしない。

## 止まる条件

- Issue の番号も PR の番号も引けないとき: 付けずに、その理由を呼んだ側に返す
- `pbcopy` が使えないとき: クリップボードは諦め、`/rename` 行の表示だけを返す
