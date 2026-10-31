---
name: acceptance-video
description: >-
  受け入れ待ちの Issue の変更点を、30 秒以内の無音の画面録画（字幕つきの mp4）にする。Issue の「変更点」「確認方法」から seed の画面の操作の手順書を書き、人が確かめてから録画する。
  「受け入れの動画を撮って」「変更点を動画にして」「Issue の動きを録画して」と言われたときに使う。受け入れそのものを進めるのは sprint-review。
---

# acceptance-video

## 仕事

受け入れ待ちの Issue の変更点を、seed の画面の操作として録画し、30 秒以内の無音の mp4 にする。人が条件を1つずつ確かめる前に、何がどう変わったかを短く掴むための材料で、合否は変えない。
終わりは「mp4 ができ、字幕が画面に被らず、立てたサーバーを止め、seed を戻し、残したものを報告した」状態。

## 絶対にやらないこと

- 録画を見て合格と決めない。印を付けず、Issue を閉じない（理由: 受け入れは人の判断で、`sprint-review` が人の答えで進める）
- 手順書を人に見せずに録画しない（理由: Issue の文を画面の操作に直す解釈はセッションがするので、録画の前に人が確かめる）
- 本番を録画しない。`--remote` を付けた `wrangler d1` と `wrangler deploy` は打たない（`CLAUDE.md` の「守ること」）
- 本体の作業コピーで `pnpm preview` を立てない。手順 3 のワークツリーで立てる（理由: `worktrees/` や `build/` の変更で開いている画面が読み直される。#367）

## 前提

手元のセッションだけで使う。クラウドのセッションは対象にしない。

- `ffmpeg`、`python3` と Pillow、macOS の日本語フォント（ヒラギノ）
- Playwright の Chromium（入っていなければ `pnpm exec playwright install chromium`）

## 手順

### 1. 手順書を書く

Issue の本文を読み、見せる動きを2〜4 場面に絞る。

```bash
gh api repos/{owner}/{repo}/issues/<番号> --jq .body
```

- 見せる動きは、本文の「変更点」と「確認方法」から選ぶ。「やらないこと」の動きは入れない
- 画面の要素の指し方と、seed の ID、画面の道筋は、その画面の e2e（`e2e/<画面>.test.ts`）から写す
- 形は `example-574.json`（#574 の録画）が見本。場面は `caption`（字幕）、`mark`（枠で示す要素）、`actions`（操作）、`read` と `hold`（待ち）を持つ
- 字幕は1場面に1つの動きだけを書き、38 文字以内にする。字幕を変えるのは画面が止まっているときで、ダイアログが開いて閉じる間は同じ字幕のままにする。`record.mjs` が、字幕を出してから約 2 秒は画面を動かさない
- 手順書はスクラッチパッドに書く

```bash
node .claude/skills/acceptance-video/record.mjs --check <steps.json>
```

形の誤りと、待ちだけの長さを確かめる。終了コード 0 が、この手順の終わり。26 秒を超えると 1 で止まる（録画は、待ちの合計に読み込みの分が約 2.5 秒足される）。

### 2. 人に手順書を見せる

場面ごとの字幕と操作を一覧にして出し、`AskUserQuestion` で録画してよいかを聞く。直したい点があれば手順 1 に戻る。人が「録画してよい」と答えたら先へ進む。

### 3. 手元を立てる

`sprint-review` の手順 2 の「手元を立てる」と同じに、`origin/main` の detached のワークツリー（`worktrees/review-<日付>`）で `pnpm install` と `pnpm preview` を行う。`pnpm preview` はバックグラウンドで走らせる。録画は、このワークツリーの根で行う。

### 4. 録画して mp4 にする

録画の操作は seed の行を書き換える（報酬の変更など）。毎回 `pnpm db:seed` から始める。

```bash
pnpm db:seed
node .claude/skills/acceptance-video/record.mjs <steps.json> <出力のディレクトリ>
python3 -I .claude/skills/acceptance-video/compose.py <出力>/recording.webm <出力>/cues.json <出力>/issue-<番号>.mp4
```

`compose.py` の終了コードが 3 なら 30 秒を超えている。手順書の待ちを縮めるか場面を減らして、`pnpm db:seed` から撮り直す。

### 5. 確かめる

1 秒ごとのフレームを1枚に並べ、画像として読む。

```bash
ffmpeg -y -loglevel error -i <mp4> -vf "fps=1,scale=480:-1,tile=7x4" -frames:v 1 <出力>/contact.png
```

- 字幕が画面の外の帯にあり、画面に被っていない
- 字幕が変わる前後で、画面が止まっている
- 操作の結果が映っていて、枠が残っていない

動きの滑らかさは、フレームからは分からない。再生して見るよう、人に mp4 の場所を渡す。

### 6. 片付けて報告する

`pnpm preview` のバックグラウンドのタスクを止め（`pkill` は使わない）、`pnpm db:seed` で D1 を戻す。ワークツリーは人に聞いてから消す（`sprint-review` の手順 7）。
mp4 の場所と長さ、手元に残したもの（ワークツリー、書き換えた D1 を戻したか）を報告する。
