---
name: daily-scrum
description: スプリントのゴールに向けて今の状態を点検し（済み ÷ 計画、残りの日数、待ち、受け入れ待ちの滞り、作業中と上限）、人の手元の開発ボード（claude.ai の Artifact「Scrum Guild 開発ボード」）を GitHub から作り直したデータで出し直し、着手を選ぶなら backlog-pick へ続ける。「デイリースクラム」「今日の状況」「開発ボードを更新して」（前の呼び方の「進捗の図を更新して」「機能マップを更新して」も）と言われたとき、Issue を分けた後、PR がマージされた後に使う。スプリントの計画と締めは sprint-plan、受け入れは sprint-review。
---

# daily-scrum

## 仕事

スプリントのゴールに届くかを点検し、人が今日決めることを出す。手元のセッションでは、開発ボードも GitHub の今の状態から作り直したデータで、同じ URL のまま出し直す。
終わりは「点検の結果が出て、手元なら、今の GitHub から作った `data.json` を載せた開発ボードの版が出ている」状態。
このスキルは Issue を書き換えない。計画を変えるか（スプリントから外す、途中で足す）は人が決め、ラベルの付け外しは人の答えを受けて `sprint-plan` か人が行う。

- 開発ボードの URL: https://claude.ai/artifact/AVrhMgarMzbpHFwAKYtM4Z （作った人だけの非公開）
- 開発ボードは、スクラムの3つの成果物を切り替えて見せる（`docs/development.md` の「スクラムのイベントと成果物」）。既定はスプリントバックログ
- ページの元は `page/` にある。`index.html`（描くだけ）、`board.js`（データから見せる形を組む関数）、`features.json`（要件の機能の一覧）。`data.json` は毎回スクリプトで作る生成物で、コミットしない

`pr-feedback` のマージの後片付けから「ボードだけ」（前の呼び方は「図だけ」）と渡されたときは、手順 1 と 3 を行い、手順 2 と 4 を飛ばす。

## GitHub の操作

データは `scripts/progress-data.ts` が `gh api` の REST で引く。クラウドのセッションでは、GraphQL を使う `gh issue` が 403 で止まるため。状態の読み方と数え方はスクリプトが持つので、このスキルで Issue の状態を読み直さない。
スクリプトが落ちる（`gh` が無い、認証で失敗する）ときは、`pr-create/github-mcp.md` に従い、GitHub の MCP ツールで Issue、開いた PR、記録の Issue（`sprint-log`）を引いて手順 2 を数え、`docs/development.md` の「スプリントとポイント」と「Issue の状態」の読み方に合わせる。そのときは開発ボードを出し直さず、出し直さなかったことを報告する（手で数えたデータを載せると、ボードが GitHub と食い違うため）。

## 手順

### 1. データを作る

ページの元とスクリプトを `origin/main` から取り出し、その場所にデータを書く。作業コピーが `main` に遅れていても、マージ済みのページと、それに合う形のデータで出すため。`<作業場所>` はスクラッチパッドの中の新しいディレクトリにする。スクリプトの `gh` はカレントのリポジトリを読むので、リポジトリの中から走らせる。

```bash
git fetch origin
mkdir -p <作業場所>
git archive origin/main .claude/skills/daily-scrum/page scripts/progress-data.ts | tar -x -C <作業場所>
node <作業場所>/scripts/progress-data.ts <作業場所>/.claude/skills/daily-scrum/page/data.json
```

スクリプトは、Issue（閉じたものも）とサブ Issue の並び、開いた PR とマージ済みの PR、記録の Issue と締めのコメント、開いた Issue の前に要るものを引き、`{ asOf, sprint, issues, history }` を書く。中身の形はスクリプトの冒頭のコメントにある。

### 2. 点検する

`data.json` の `sprint`、`issues`、`history` から、今のスプリントについて次を出す。数え方は `docs/development.md` の「スプリントとポイント」に従い、スクリプトが出した数をそのまま使う。`sprint` の数はどれも `{ pt, count }` で、進み具合と残りはポイント（`.pt`）、受け入れ待ちは両方、作業中と上限は件数（`.count`）で見る。`history` の `planned` も `{ pt, count }` で、`velocity` はポイントの数。`sprint` が `null` なら、「スプリントは計画されていない」と書き、`sprint-plan` を推して手順 3 へ進む。開いている記録の Issue が2つあれば、スクリプトは番号の大きいほうを選ぶので、`sprint-plan` が途中で止まっていることを点検の結果に書く（`gh api "repos/{owner}/{repo}/issues?labels=sprint-log&state=open" --jq 'length'` で確かめる）。

| 見るもの | 出し方 | 人に勧めること |
| --- | --- | --- |
| 進み具合 | `plannedDone.pt` ÷ `planned.pt`、`addedDone.pt`、残りの日数（今日を含めて数え、最終日は 1、過ぎたら 0） | 残りの計画のポイント（`planned.pt` − `plannedDone.pt` − `withdrawn.pt`）が「直近のベロシティの平均（`history` の新しい3つまでの `velocity`）× 残りの日数 ÷ 7」を超えるなら、外す候補（作業中でないもの。`s` が `todo` か `refining`）を挙げる。`history` が空なら判定しない |
| 受け入れ待ち | `accepting.count` と `accepting.pt` | `accepting.count` が1以上で、残りの日数が2日以下なら、`sprint-review` を先に行う（済みに数えるのは受け入れで閉じた Issue だけなので、締めの前に受け入れる） |
| 待ち | `sprint` が今のスプリントで、`waitingOn` が空でない Issue | 前に要るものがスプリントの外なら、先に入れるか、待つ側を外すかを人が決める |
| 作業中と上限 | `wip.count` / `wipLimit`（`wipLimit` が `null` なら、記録の Issue に上限が無いと書く） | 上限に達していれば、着手を足さず、レビュー中と受け入れ待ちを先に片付ける |
| スプリントの外の作業 | `sprint` が今のスプリントでなく、`s` が `wip` か `review` の Issue | 途中で足すかを人が決める |

勧めることは出すだけにし、ラベルは付け外ししない。

### 3. 開発ボードを出し直す

Artifact のツールがある手元のセッションでだけ行う。無ければ飛ばし、飛ばしたことを報告する。

1. `Artifact` の `action: "read"` に URL を渡して読む。同じ URL へ出し直すのに要る読み取りで、中身は使わない（ページはいつも `page/` から出す）
2. `action: "publish"` で、`url` に開発ボードの URL、`file_path` に `<作業場所>/.claude/skills/daily-scrum/page/index.html`、`root` に同じ `page/` のディレクトリ、`files` に `{"board.js": "board.js", "data.json": "data.json", "features.json": "features.json"}` を渡す。ページは同じ場所の3つを相対の URL で読むので、どれかが漏れると描けない
3. 出し直しが新しい版との衝突で断られたら、もう一度 read してから出し直す。ページの中身は `page/` が正なので、断りで渡された版に合わせて直さない

ページの見た目や組み立てを変えたいときは、ここで直さず、Issue を立てて `page/` を PR で直す（`board.js` のテストは `scripts/board-page.test.ts`）。

### 4. 着手を選ぶかを聞く

`AskUserQuestion` で、続けて `backlog-pick` で着手を選ぶかを聞く。作業中が上限に達しているか、受け入れ待ちが多いときは、推す案を「人の番を先に片付ける」にする。選ぶと答えたら、Skill ツールで `backlog-pick` を起動する。
人に聞けない実行では、聞かずに終える。

## 機能の一覧を直す

手順の外で、要件が変わったときに行う。`docs/requirements.md` の「機能」、`docs/ai.md` の「決めること」、`docs/design.md` の「画面一覧」を変える PR では、同じ PR で直す（`docs/development.md` の「スクラムのイベントと成果物」）。開発ボードのプロダクトバックログに出る要件の機能（領域、機能、段階、受け持つ Issue）は `page/features.json` だけが持つ。機能の状態は受け持つ Issue の状態からページが出すので、Issue が進んでも直さない。次のときに Issue を立て、PR で `features.json` を直す。

- `docs/requirements.md` の「機能」で、後回しから初版に移った機能は `phase` を外し（既定が初版）、受け持つ Issue を `issues` に入れる
- AI の機能は、`docs/ai.md` の「決めること」で初版に入れると決まったら `phase: "open"` を外す
- 新しく立った機能の Issue は、当たる領域の機能の `issues` に足すか、機能を足す。親 Issue に子ができても、機能には親の番号を載せる。開発の仕組みだけの Issue（フックの直しなど）は載せない
- 受け持つ Issue が `not_planned` か `duplicate` で閉じたら、`issues` から外し、引き継いだ Issue があればその番号に替える。`data.json` はそうして閉じた Issue を含まないので、残すと機能がいつまでも未着手と出る

`phase` は `later` か `open` か無し（初版。`first` と書いてもよい）、`issues` は整数の番号だけにする。ページは知らない値を黙って初版や無しに読み替えるので、形は `scripts/board-page.test.ts` が実のファイルで確かめる。点検の中で `features.json` と要件の食い違いに気づいたら、点検の結果に書いて人に伝える。

## 出力

- 点検の結果（手順 2 の表の各行）と、人に勧めること
- 手元なら、出し直した開発ボードの URL と、データの `asOf`。クラウドか、スクリプトが落ちたときは、出し直さなかったこと
