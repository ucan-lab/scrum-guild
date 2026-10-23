# Team Leveling

チームのタスクを集め、ゲームの仕組みで回すサービス。Cloudflare Workers（Hono、D1、R2）と SvelteKit の SPA モード。道具の選択は `docs/development.md` の「技術の選択」。今の状態と次にやることは `HANDOFF.md`。

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
  - 例外: GitHub のブランチ保護を入れるまでは、文書だけの変更（`docs/`、`HANDOFF.md`、`CLAUDE.md`、`.claude/` のスキルとエージェントとチェックリスト、`.github/ISSUE_TEMPLATE/`）は `main` に直接入れてよい。コードと設定は例外にしない。ブランチ保護を入れたらこの例外を消す
- 本番に触らない。`wrangler deploy`、`wrangler versions deploy`、`--remote` を付けた `wrangler d1` は CI だけが実行する
- 組織の中の表を読み書きするときは、必ず組織で絞る。共通の表と組織の中の表を結合せず、1回の `batch()` に混ぜない（`docs/data-model.md` の「データベースの分け方」）
- DB への書き込みは、文を並べて `batch()` で1つのトランザクションとして送る
- D1 には Kysely の入口（共通の表の入口と、組織を確かめた後の入口）からだけ問い合わせる。まとめて書くときも入口の `batch()` の関数を使う。D1 の binding を直接使わない
- API の操作は、`src/shared` の操作の定義に足して作る。ルートを直に書かない
- 画面は SPA として作る。`+page.server.ts`、`+layout.server.ts`、`+server.ts`、form actions は使わない。データは Hono の API から取る
- マイグレーションは足すだけにし、既にあるファイルを書き換えない。列や表を消すのは、使わなくなった版を出した後の別の PR で行う。ベータの前にまとめ直すのは、人が決めた Issue の中でだけ（`docs/development.md` の「DB を作り直してよい期間」）
- API のエラーは決まった形と `code` で返す。別の組織の ID は存在しないときと同じ 404 にする。ログに本文、取り込んだ内容、認証情報を出さない
- 画面の文言は言葉の辞書を通して出し、ゲームの言葉とスクラムの言葉の両方を用意する
- 画面ごとの CSS を持たない。足りない部品は先にデザインシステムへ足す
- 仕様を変える実装は、同じ PR で `docs/` も直す
- 例のデータはすべて架空にし、実在の名前を混ぜない
