# Scrum Guild

チームのタスクを集め、ゲームの仕組みで回すサービス。Cloudflare Workers（Hono、D1、R2）と SvelteKit の SPA モード。道具の選択は `docs/development.md` の「技術の選択」。今の状態と次にやることは GitHub の Issue で追い、自分のチームで使い始めるまでのものはマイルストーン「初版」に入れる。

## 文書

| 知りたいこと | 文書 |
| --- | --- |
| 要件 | `docs/requirements.md` |
| 誰が何をできるか（ユースケース図） | `docs/use-cases.md` |
| 表と列 | `docs/data-model.md` |
| 画面とデザインの決まり | `docs/design.md`、見本は `design/`（`design/index.html` をブラウザで開く。人に見せるときは `docs/development.md` の「見本の Worker」） |
| ブランチ、PR、CI/CD、スキルの使い分け | `docs/development.md` |
| 本番の用意、出し方、戻し方 | `docs/operations.md` |
| サービスにする方針、値段 | `docs/business.md`、競合との比較は `docs/competitors.md` |
| AI の機能の案 | `docs/ai.md` |
| 名前の決定の記録 | `docs/naming.md` |
| 要件にする前のアイディア | `docs/ideas.md` |

## コマンド

Node は `.node-version`（26）、pnpm は `package.json` の `packageManager` の版を使う。

- 依存の導入: `pnpm install`（`prepare` が `core.hooksPath` を `.githooks` にし、`main` を守る git のフックを有効にする）
- 開発用のサーバー: `pnpm dev`（画面 `http://localhost:5173`、`/api` は `wrangler dev` へ転送）。ワークツリーではポートが名前から自動で決まり、Issue の番号が違うワークツリーとは重ならない（441 を超える番号と番号の無い名前は重なりうる。直し方は `docs/development.md` の「ポート」）
- 本番と同じ配り方での確認: `pnpm preview`（build して `http://localhost:8787`）
- テスト: `pnpm test`（API は Workers の実行環境、画面のコード（`src/` の `*.test.ts`）は vitest の node の環境、runes を使うコード（`src/` の `*.svelte.test.ts`）はブラウザ向けの Svelte で動かす node の環境、`scripts/` と `cli/lib/` は `node --test`）。`pnpm test:vitest` と `pnpm test:node` に分けて走らせられる（CI も別のジョブで、vitest はさらに2つのシャードに分ける）
- 型の検査: `pnpm check`（`svelte-check`、Worker の `tsc`）。Worker の型（`worker-configuration.d.ts`）は、`pnpm install`、`dev`、`test`、`check` の前に `wrangler types` で作り直す
- lint と整形: `pnpm lint`、`pnpm format:check`、直すときは `pnpm format`
- build: `pnpm build`（`build/` に書き出し、`build/_headers` を作る）
- フックのテスト: `node --test .claude/hooks/*.test.mjs`
- CLI: `pnpm -s sg ops`、`pnpm -s sg call <操作名>`（API トークンで操作を呼ぶ。設定と手元のサーバーへの向け方は `docs/development.md` の「CLI（sg）」）、`pnpm -s sg mcp`（MCP の stdio サーバー。登録は `docs/development.md` の「MCP（sg mcp）」）
- e2e: Claude のセッション（手元でもクラウドでも）は手元で走らせない（`pnpm e2e`、`playwright test` はフックが止める）。PR の CI の `e2e`、`e2e-dev`、`e2e-repeat` が確かめ、落ちたらジョブのログと成果物の trace で直す（`docs/development.md` の「CI の e2e が落ちたとき」）。人が自分の端末で調べるときは `pnpm e2e`（build し直してサーバーを立て、手元の D1 を seed で入れ直してから Playwright で確かめる。手元の D1 の行は消える。初めは `pnpm exec playwright install chromium`）で、`pnpm e2e e2e/members.test.ts` のようにファイルを渡せる。サーバーの扱い、`--workers`、`expect` の待ち、`E2E_DEV_BUILD=1` は `docs/development.md` の「e2e のサーバー」「e2e の書き方」
- 空の D1 に全マイグレーションを当て、seed を2回流して確かめる: `pnpm db:migrate:fresh`
- バックログの木を 5 万件で測る: `pnpm bench:backlog`（使い捨ての D1 で `wrangler dev --local` を立てて測る。`docs/development.md` の「バックログの木を 5 万件で測る」）
- 手元の D1 にマイグレーションを当て、全部の行を消して seed を入れ直す: `pnpm db:seed`（ログインに使うトークンは `seed/sessions.ts`）
- seed のセッションでログインした手元の画面を、見えるブラウザで開く: `pnpm dev:open [--preview] [who] [path]`（例 `pnpm dev:open admin /aoba`。先に `pnpm db:seed` と `pnpm dev` を済ませる。ポートは `pnpm dev` と同じ決め方。環境変数 `DEV_PORT_OFFSET` で立てたときだけ同じ値を付ける）

開発用のサーバーとポート、版の渡し方は `docs/development.md` の「手元で動かす」。

## 守ること

- `main` に直接コミットも push もしない。文書だけの変更も PR を通す。1 Issue に 1 ブランチ、1 PR。ブランチ名は `<Issue番号>-<短い名前>`（クラウドのセッションの `claude/*` はそのまま）。手元では同じ名前のワークツリー（`./worktrees/<ブランチ名>`）を切って作業する（`docs/development.md` の「ワークツリーで作業する」）。`main` の作業コピーのファイルは Write と Edit をフックが止めるので、書く前にワークツリーを切る。Bash で書いて迂回しない。マージは squash で行う。セッションがマージするのは、人がその PR のマージを指示したときだけで、`needs-human` の PR と、`label` か `ci-ok` のチェックが成功していない PR は指示されても人に任せる（`docs/development.md` の「マージの判定」）。GitHub のブランチ保護は無く、`.claude/` のフックと `.githooks/` は踏み線にすぎないので、この決まりは自分で守る
- 実装を終えたら、確認を取らずにコミットし、`done-check` を通して PR を作る。`pr-create` も承認を取らずに作成まで進め、作った後に内容を報告する（作業ブランチのコミットと PR は後から直せるため）。承認を取るのは `pr-create` の Step 4 に挙げた場合（直さなかった CRITICAL か HIGH が残る、done-check を省いた、既存の PR を書き換える）だけ。マージは、この決まりに含めない
- セッションは手元で e2e を走らせない（フックが止める。例外も認めない）。変えた画面を開く e2e のテストを差分に足し、PR の CI に任せる。落ちたときの直し方は `docs/development.md` の「CI の e2e が落ちたとき」と「開発の流れ」
- 本番に触らない。`wrangler deploy`、`wrangler versions deploy`、`wrangler rollback`、`--remote` を付けた `wrangler d1` は Cloudflare の Workers Builds だけが実行する
- 組織の中の表を読み書きするときは、必ず組織で絞る。共通の表と組織の中の表を結合せず、1回の `batch()` に混ぜない（`docs/data-model.md` の「データベースの分け方」）
- DB への書き込みは、文を並べて `batch()` で1つのトランザクションとして送る
- D1 には Kysely の入口（共通の表の入口と、組織を確かめた後の入口）からだけ問い合わせる。まとめて書くときも入口の `batch()` の関数を使う。D1 の binding を直接使わない
- API の操作は、`src/shared` の操作の定義に足して作る。ルートを直に書かない
- 画面は SPA として作る。`+page.server.ts`、`+layout.server.ts`、`+server.ts`、form actions は使わない。データは Hono の API から取る
- マイグレーションは足すだけにし、既にあるファイルを書き換えない。列や表を消すなどの縮める変更は、使わなくなった版を出した後の別の PR で行う（区分は `d1-migration`）。ベータの前にまとめ直すのは、人が決めた Issue の中でだけ（`docs/development.md` の「DB を作り直してよい期間」）
- API のエラーは決まった形と `code` で返す。別の組織の ID は存在しないときと同じ 404 にする。ログに本文、取り込んだ内容、認証情報を出さない
- 画面の文言は言葉の辞書を通し、スクラムの言葉で出す（言葉づかいは選べない）
- 画面ごとの CSS を持たない。足りない部品は先にデザインシステムへ足す
- 仕様を変える実装は、同じ PR で `docs/` も直す
- 例のデータはすべて架空にし、実在の名前を混ぜない
