# Team Leveling

チームのタスクを集め、ゲームの仕組みで回すサービス。Cloudflare Workers（Hono、D1、R2）と Svelte の SPA。今の状態と次にやることは `HANDOFF.md`。

## 文書

| 知りたいこと | 文書 |
| --- | --- |
| 要件 | `docs/requirements.md` |
| 表と列 | `docs/data-model.md` |
| 画面とデザインの決まり | `docs/design.md`、見本は `design/` |
| ブランチ、PR、CI/CD、スキルの使い分け | `docs/development.md` |

## コマンド

実装を始めたら、ここに依存の導入、開発用のサーバー、テスト、lint、型の検査のコマンドを書く。

## 守ること

- `main` へ直接 push しない。1 Issue に 1 ブランチ、1 PR。マージは squash で、人か GitHub の auto-merge が行う。セッションからはマージしない
- 本番に触らない。`wrangler deploy`、`wrangler versions deploy`、`--remote` を付けた `wrangler d1` は CI だけが実行する
- 王国の中の表を読み書きするときは、必ず王国で絞る。共通の表と王国の中の表を結合せず、1回の `batch()` に混ぜない（`docs/data-model.md` の「データベースの分け方」）
- DB への書き込みは、文を並べて `batch()` で1つのトランザクションとして送る
- マイグレーションは足すだけにし、既にあるファイルを書き換えない。列や表を消すのは、使わなくなった版を出した後の別の PR で行う
- 画面の文言は、ゲームの言葉とスクラムの言葉の両方を用意する
- 画面ごとの CSS を持たない。足りない部品は先にデザインシステムへ足す
- 仕様を変える実装は、同じ PR で `docs/` も直す
- 例のデータはすべて架空にし、実在の名前を混ぜない
