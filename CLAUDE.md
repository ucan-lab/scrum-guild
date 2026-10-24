# Scrum Guild

チームのタスクを集め、ゲームの仕組みで回すサービス。Cloudflare Workers（Hono、D1、R2）と SvelteKit の SPA モード。道具の選択は `docs/development.md` の「技術の選択」。今の状態と次にやることは `HANDOFF.md`。

## 文書

| 知りたいこと | 文書 |
| --- | --- |
| 要件 | `docs/requirements.md` |
| 表と列 | `docs/data-model.md` |
| 画面とデザインの決まり | `docs/design.md`、見本は `design/` |
| ブランチ、PR、CI/CD、スキルの使い分け | `docs/development.md` |

## コマンド

Node は `.node-version`（26）、pnpm は `package.json` の `packageManager` の版を使う。

- 依存の導入: `pnpm install`
- 開発用のサーバー: `pnpm dev`（画面 `http://localhost:5173`、`/api` は `wrangler dev` へ転送）。ワークツリーを並べるときは `DEV_PORT_OFFSET=10 pnpm dev` のようにずらす
- 本番と同じ配り方での確認: `pnpm preview`（build して `http://localhost:8787`）
- テスト: `pnpm test`（API は Workers の実行環境、`scripts/` は `node --test`）
- 型の検査: `pnpm check`（`svelte-check`、Worker の `tsc`）。Worker の型（`worker-configuration.d.ts`）は、`pnpm install`、`dev`、`test`、`check` の前に `wrangler types` で作り直す
- lint と整形: `pnpm lint`、`pnpm format:check`、直すときは `pnpm format`
- build: `pnpm build`（`build/` に書き出し、`build/_headers` を作る）
- フックのテスト: `node --test .claude/hooks/*.test.mjs`
- e2e: `pnpm e2e`（`pnpm preview` を立てて Playwright で確かめる。初めは `pnpm exec playwright install chromium`）
- 空の D1 に全マイグレーションを当てる: `pnpm db:migrate:fresh`

開発用のサーバーとポート、版の渡し方は `docs/development.md` の「手元で動かす」。

## 守ること

- `main` へ直接 push しない。1 Issue に 1 ブランチ、1 PR。ブランチ名は `<Issue番号>-<短い名前>`（クラウドのセッションの `claude/*` はそのまま）。手元では同じ名前のワークツリー（`./worktrees/<ブランチ名>`）を切って作業する（`docs/development.md` の「ワークツリーで作業する」）。マージは squash で行う。セッションがマージするのは、人がその PR のマージを指示したときだけで、`needs-human` の PR と、`label` か `ci-ok` のチェックが成功していない PR は指示されても人に任せる（`docs/development.md` の「マージの判定」）。GitHub のブランチ保護は無く、`.claude/` のフックは踏み線にすぎないので、この決まりは自分で守る
  - 例外: 文書だけの変更（`docs/`、`HANDOFF.md`、`CLAUDE.md`、`.claude/` のスキルとエージェントとチェックリスト、`.github/ISSUE_TEMPLATE/`）は `main` に直接入れてよい。セッションはコミットまでで、`main` への push は人が行う（フックが止める）。コード、設定、マイグレーションは例外にしない。CI が重いジョブを飛ばす「文書だけ」も同じ範囲で、変えるときは `scripts/ci.ts` も直す
- 実装を終えたら、確認を取らずにコミットし、`self-review` を通して PR を作る。`pr-create` も承認を取らずに作成まで進め、作った後に内容を報告する（作業ブランチのコミットと PR は後から直せるため）。承認を取るのは `pr-create` の Step 4 に挙げた場合（直さなかった CRITICAL か HIGH が残る、self-review を省いた、既存の PR を書き換える）だけ。マージと、`main` に入れるコミットの push は、この決まりに含めない
- 本番に触らない。`wrangler deploy`、`wrangler versions deploy`、`wrangler rollback`、`--remote` を付けた `wrangler d1` は Cloudflare の Workers Builds だけが実行する
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
