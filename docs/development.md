# Scrum Guild の開発の進め方

状態: 方針（2026-10-22 に決めた）。土台を作るときに、道具の名前や設定の細部を足す。

前提: 作るのはほぼ1人で、実装の多くは Claude のクラウドのセッションが受け持つ。ステージングは持たず（`requirements.md` の「運用」）、D1 のマイグレーションは戻せない。全組織が1つの D1 に入る。

## 技術の選択

`requirements.md` の「技術の前提」に加えて、土台を作る前に次を決めた（2026-10-22）。

| 項目 | 決定 | 理由 |
| --- | --- | --- |
| パッケージマネージャー | pnpm。`package.json` の `packageManager` で版を固定する | 速く、依存が厳密 |
| リポジトリの形 | 1つのパッケージ。`src/server`（Hono の API と定期処理）、`src/client`（SvelteKit）、`src/shared`（操作の定義、スキーマ、言葉の辞書）に分ける | Worker が1つなので、ワークスペースに分ける設定の手間に見合わない |
| lint と整形 | ESLint と Prettier（`eslint-plugin-svelte`、`prettier-plugin-svelte`） | Svelte のテンプレートの中まで見られる。下の「入口を守る規則」を自前で書ける |
| 画面 | SvelteKit の SPA モード。SSR を切り、静的に書き出す。API は Hono のまま | 組織、ワークスペース、画面の入れ子をレイアウトで表せる。画面と API の版のずれを `version.pollInterval` と `updated` で検知できる。AI が書き慣れている |
| D1 への問い合わせ | Kysely。マイグレーションは SQL のファイルで手書きし、wrangler で当てる | 型付きで SQL に近い。組織を確かめた入口からしか組織の中の表を引けない型を作れる |
| スキーマ | zod | Hono のバリデーター、Claude の道具や MCP の定義（JSON Schema）への変換など、周りの道具が揃っている |
| 操作の定義 | 自前の定義から形を推論する。コードの生成はしない | 下の「操作の定義」 |
| 言葉の切り替え | 型付きの辞書を自前で持つ | 下の「言葉の辞書」 |
| 架空のデータ | seed とファクトリーの両方 | 下の「架空のデータ」 |

### 操作の定義

`ai.md` の「操作の定義を1か所に持つ」の形。

- 操作ごとに、名前、説明、入力と出力の zod のスキーマ、読むだけか書き込むか、要る権限（ログインだけ、ワークスペースのメンバー、管理者、運用者など）を1つのオブジェクトに書き、`src/shared` に置く。
- Hono のルートは、定義を並べて1つの関数で登録する。権限の検査と入力の検証はその関数が行い、操作ごとの処理には検証済みの入力と、組織を確かめた DB の入口だけを渡す。
- 画面からは、定義を引数に取る型付きの呼び出しの関数で呼ぶ。入力と出力の型は定義から推論する。
- 組織の分離のテストは、定義の一覧を回して全操作に当てる。新しい操作を足すと、テストが自動で増える。
- 後で足すアシスタントの道具と MCP の道具も、同じ定義から作る。

### 入口を守る規則

- Kysely の型を、共通の表の入口と組織の中の表の入口の2つに分ける。組織の中の入口は、組織を確かめた後にしか手に入らない形にする。
- Kysely は D1 の `batch()` を持たないので、入口に、Kysely で組み立てた文を受け取って1回の `batch()` で送る関数を持たせる。共通の表の文と組織の中の表の文を混ぜて渡せない型にする。
- 入口の外から D1 の binding や Kysely を直接使うことを、ESLint の規則で禁じる。

### 言葉の辞書

- 見本の `design/kit.js` の `vocab` と同じく、キーごとにゲームの言葉とスクラムの言葉を持つ辞書を TypeScript で書き、`src/shared` に置く。
- 片方の言葉が欠けたら型の検査で落ちる形にする。画面の文言は辞書を通して出し、直に書かない。

### 架空のデータ

- seed: `design/sample-data.js` を元に、組織を2つ以上入れたデータを作る。ローカルの D1 と e2e に入れる。組織の分離を画面で確かめられるようにするため。
- ファクトリー: 単体と結合のテストは、テストごとにファクトリーの関数で必要な行だけを作る。seed を直してもテストが壊れないようにするため。
- どちらも架空の名前だけを使う。

### API のエラーとログ

- エラーの応答は `{ "error": { "code": "...", "message": "...", "details": ... } }` の自前の形にする。`code` は `src/shared` の列挙で持ち、画面は `code` で分岐して、文言は言葉の辞書から出す。`message` は開発者向けで、画面にそのまま出さない。
- 別の組織の ID を指定されたときは、存在しないときと同じ `not_found` の 404 を返す。
- 入力の誤りは 400 の `invalid_input` で、`details` に zod の検証の結果を項目ごとに入れる。権限が無いのは 403、先に読んだ値で判定した書き込みの競合（`meta.changes` が 0）は 409 にする。
- 想定していないエラーは `app.onError` で 500 の `internal` にし、中身は応答に出さずログにだけ出す。
- ログは Workers Logs に JSON の1行で出す。リクエストの ID、操作の名前、組織の ID、ユーザーの ID、`code`、かかった時間を入れ、本文、コメント、取り込んだ内容、認証情報は出さない。

## 初版の作る順

最初の一本は、運用者が組織を作る → GitHub でログインする → ワークスペースを作る → タスクを1件作って完了する、の一本道にする（2026-10-22 に決めた）。認証、組織の分離、操作の定義、`batch()` での書き込み、画面を一度に通し、CI/CD と本番へのデプロイもこの一本に含める。Issue への分け方は `issue-plan` で決める。目安は次のとおり。

1. 土台: pnpm、SvelteKit の SPA モード、Hono、wrangler の設定、ESLint と Prettier、`CLAUDE.md` の「コマンド」、セキュリティのヘッダー。Claude の設定とフック（下の「Claude の設定とフック」）は先に入れる
2. CI と CD: `ci-ok`、Workers Builds とデプロイのスクリプト、`/api/health`、煙のテスト、`docs/operations.md`
3. 入口: Kysely の2つの入口と `batch()` の関数、操作の定義を登録する関数、エラーの形、組織の分離のテストの仕組み
4. 一本道に要る表のマイグレーションと seed
5. 運用者の組織の作成、GitHub OAuth とセッション、組織の選択
6. ワークスペースの作成、タスクの作成と完了（完了の記録、経験値、変更の履歴を1回の `batch()` で書く）

### DB を作り直してよい期間

ベータ（自分のチーム以外の組織）が始まるまでは、本番の D1 を作り直し、マイグレーションをまとめ直してよい（2026-10-22 に決めた）。

- 作り直すかは人が決める。AI は既にあるマイグレーションのファイルを書き換えず、まとめ直すときは人が決めた Issue の中でだけ行う。
- 自分のチームのデータは作り直しのたびに入れ直す。取り込み元から入れ直せないもの（完了の記録、経験値、手で作ったタスク）は消える前提で使う。
- ベータを始める日に、CI の migration のジョブで既にあるファイルの書き換えを落とす検査を有効にし、この節を「済み」にする。

## ブランチ戦略

短命なブランチを `main` へ PR で入れる。`main` は常にデプロイできる状態に保つ。

| 項目 | 決まり |
| --- | --- |
| 長く残すブランチ | `main` だけ。`develop` や `release` は作らない。ステージングが無いので、分けても受け皿がない |
| 作業ブランチ | 1 Issue に 1 ブランチ、1 PR。クラウドのセッションが作る `claude/*` はそのまま使う。手で切るときは `<Issue番号>-<短い名前>`（例 `12-org-create`）。スラッシュを使わず、ワークツリーと同じ名前にする。種別は PR のタイトルで表す |
| マージ方法 | squash merge だけ。PR のタイトルが `main` のコミットの件名になり、本文は空にする |
| PR のタイトル | 今のコミットと同じ書き方（`feat:`、`fix:`、`docs:`、`design:`、`refactor:`、`chore:`、`test:`、`ci:` の後に日本語） |
| マージ後 | ブランチを自動で消す |
| 文書だけの変更 | `CLAUDE.md` の「守ること」の例外に挙げた文書だけの変更は、`main` に直接入れてよい。セッションはコミットまでで、push は人が行う。それ以外は PR を通す |

### `main` を守る仕組み

GitHub は無料のプランのまま使う（2026-10-23 に決めた）。無料のプランの private のリポジトリでは、ブランチ保護、Rulesets、auto-merge、Environment が使えない。そのため、守りは次のように置く。

- リポジトリの設定で squash merge だけを許し、マージ後にブランチを消す。squash のコミットの件名は PR のタイトルにし、本文は空にする（設定済み）
- `main` への直接の push と force push は、PreToolUse のフック（`.claude/hooks/guard-bash.mjs`）でセッションから止める。人の push は止まらないので、人も同じ決まりで PR を通す
- 必須のチェックは設定できない。マージする人かセッションが `ci-ok` の成功を確かめてからマージする
- マージは人が決める。人が押すか、人の指示でセッションが `gh pr merge` を打つ。承認の数は求めず、人のレビューは「人がマージを決める」ことで表す（下の「マージの判定」）
- 本番へデプロイする鍵は GitHub に置かない（下の「CD」）。リポジトリのシークレットは PR のブランチのワークフローからも読め、Environment で `main` だけに絞れないため

### 並行して作業するときの決まり

- マイグレーションを含む PR は同時に1本まで。番号がぶつかるため。Issue に `migration` のラベルを付けて見分ける
- スタック PR は原則使わない。squash merge と相性が悪く、force push が増える
- ベースが進んだら `sync-base` で merge して取り込み、通常の push をする。rebase はしない。squash merge なのでブランチの履歴は `main` に残らず、rebase は force push とレビュワーが読んだ差分の消失を招くだけになる

### ワークツリーで作業する

手元のセッションは、Issue ごとにワークツリーを切って作業する。メインの作業コピーは `main` のまま置き、並行するセッションが同じファイルを書き換え合わないようにする。クラウドのセッションは環境が分かれているので、ワークツリーを切らない。

- 置き場所は `./worktrees/<ブランチ名>`。ワークツリーの名前とブランチ名を同じにする（例 `worktrees/12-org-create` に `12-org-create`）
- 切るときは最新の `main` から作る: `git fetch origin` のあと `git worktree add worktrees/<名前> -b <名前> origin/main`
- `worktrees/` はリポジトリの `.gitignore` で git の管理から外してある
- 依存はワークツリーごとに入れる。ローカルの D1（`.wrangler/state`）もワークツリーごとに分かれるので、seed もそれぞれで当てる。並べて `wrangler dev` を立てるときはポートをずらす
- PR がマージされたら、`~/.claude/scripts/git-cleanup-merged.sh <名前>` でワークツリーと手元のブランチを消す（`pr-feedback` の後片付け）。squash merge では SHA が変わり `git branch -d` が拒むため、PR がマージ済みで head の SHA が手元と一致するときだけ `-D` で消す。スクリプトは dotfiles にあり、無い環境では人が消す

## AI 開発の分担

人が決め、AI が作り、別の AI が点検する。マージするかは、パスの規則と人が決める。

| 工程 | 担い手 | 道具 |
| --- | --- | --- |
| 何を作るか、仕様の判断 | 人 | `grill-me` で詰め、`docs/` に書く |
| Issue と完了条件 | AI が書き、人が確かめる | `issue-plan` |
| 実装とテスト | AI（クラウドのセッション。1 Issue に 1 セッション） | `CLAUDE.md`、リポジトリのスキル |
| 点検 | 実装したのとは別のエージェント | `self-review`、CI の AI レビュー |
| マージ | パスの規則と人 | 下の「マージの判定」 |

### AI の誤りを機械で止める

決まりはプロンプトに頼らず、テストと設定に置く。

1. **組織の分離のテストを CI で必須にする。** 一番起こりやすく、一番重い事故は `organization_id` での絞り込み漏れ。すべての API の操作について「別の組織の ID で呼ぶと 404 になる」ことを確かめるテストを、操作の定義（`ai.md` の「操作の定義を1か所に持つ」）から作る。組織の中の表に触るクエリは、組織で絞る入口の関数からしか書けないようにする。
2. **型で境界を固める。** 操作の入力と出力をスキーマで1か所に持ち、Hono と Svelte の両方で使う。片方だけ直したずれを型の検査で落とす。
3. **本番に触る操作をセッションから拒否する。** `.claude/settings.json` に登録した PreToolUse のフックで止める。本番に触るのは Cloudflare の Workers Builds だけ。下の「Claude の設定とフック」。
4. **AI への決まりは `CLAUDE.md` に短く置く。** コマンドと、守らないと事故になる決まりだけを書き、詳しいことは `docs/` を指す。

### Claude の設定とフック

クラウドのセッションにはユーザーの設定が届かず、効くのはリポジトリの `.claude/settings.json` だけ。そこで、permission のモードに関係なく効く `permissions.deny` とフックで守る。

| 仕組み | 中身 |
| --- | --- |
| `permissions.deny` | `.dev.vars`、`.env` とその環境ごとのファイル（`.local`、`.production` など）の読み取り、`.dev.vars` と `.env` の書き込み、wrangler の資格情報のディレクトリの読み取り |
| `env` | `WRANGLER_SEND_METRICS=false`（テレメトリを送らない） |
| `guard-bash.mjs` と `bash-rules.mjs`（PreToolUse、Bash と Monitor） | 止める: wrangler の本番に触る操作（許すのは `dev`、`types`、`whoami`、版と help、`--local` を付けた D1、R2、KV の操作だけ）、`--remote` と `-r` とリモートの binding、本番のログ（`tail`）、デプロイのスクリプトと名前に `deploy` を含む `package.json` のスクリプト、`main` への push、force push、`gh pr merge` を通さない PR のマージと `--auto`、`--admin`（`gh api` と `curl` の merge、`gh stack merge`、`gh alias set` と `gh alias import`、main の ref の書き換え、contents API の書き込み）、シークレットとログイン、`.dev.vars` と `.env` の中身を読むか送るコマンドと `git add`。確認を挟む: `gh pr merge`、依存の追加、削除、更新、マイグレーションの作成、`gh stack` の push 系、ブランチを判定できない push（`cd ~` や変数の先、変数か glob を含む refspec）、Bash からの `.claude/settings*.json` と `.claude/hooks/` と `migrations/` の書き換え |
| `guard-files.mjs` と `file-rules.mjs`（PreToolUse、Write と Edit と MultiEdit） | 止める: `origin/main` にあるマイグレーションの書き換え、`+page.server`、`+layout.server`、`+server`、`hooks.server`、`src/` のうち `src/server/db/` の外での `env.DB` と `D1Database`（テストも含む。テストの土台は `test/` に置く）、`.svelte` の `<style>`、wrangler の設定の `remote: true`。確認を挟む: `.claude/settings*.json` と `.claude/hooks/` の書き換え |
| `format.mjs`（PostToolUse、Write と Edit と MultiEdit） | このリポジトリのファイルを Prettier で整える。依存が入るまでは何もしない |
| `session-start.sh`（SessionStart の起動と再開） | クラウドのセッションだけで、`pnpm install --frozen-lockfile` を行う |

Bash の判定を `permissions.deny` に置かないのは、規則が前方一致で、`npx wrangler` や `pnpm exec wrangler` の言い換えを取りこぼすため。先頭に `*` を付けると、`grep "wrangler deploy"` のような読むだけのコマンドまで止まる。フックはコマンドを区切りごとに分け（コメント、行継続、`$(...)` とバッククォート、`bash -c` と `bash <<EOF` と `eval` の中身も読む）、実行する道具の名前で判定する。同じコマンドの中の `cd` と `git checkout` の後の push は移った先のブランチで、`package.json` のスクリプトは pre と post も含めた中身で見る。判定できないときは、フックが exit 2 で止める。判定を変えたら `node --test .claude/hooks/*.test.mjs` を通す。

どれも踏み線で、本当の守りは、セッションが動く環境に Cloudflare の資格情報を置かないこと。フックからは、変数の中身、パイプで `sh` に流す中身、`gh api graphql` が読むファイルの中身が見えない。

- クラウドのセッションの環境には、Cloudflare の API トークンを置かない
- 手元の機械では `wrangler login` しない（したら `wrangler logout` しておく）。シェルに `CLOUDFLARE_API_TOKEN` を置かない。手元のセッションは、人が置いた資格情報をそのまま使えるため

止められた操作を人が行うときは、Claude Code の入力欄で先頭に `!` を付けて打つ（フックを通らない）。`.dev.vars` は人が `.dev.vars.example` を写して値を入れる。

## リポジトリのスキル

### 今あるもの

2026-10-22 に下のとおり整えた。

| スキル、エージェント | 扱い |
| --- | --- |
| `issue-plan`、`pr-create`、`pr-feedback`、`self-review`、`grill-me`、`ui-polish`、`japanese-tech-writing` | 残す |
| `sync-base` | `rebase-base` を merge で取り込む形に書き換えた。force push を使わずにベースへ追従する |
| `requirements` | 外した。Backlog の要望を要件に落とす受託向けのスキルで、このリポジトリでは使い道が薄い |
| `database-reviewer` | D1（SQLite）向けに書き直した。`batch()` の原子性、共通の表と組織の中の表の混在、組織での絞り込み、マイグレーションを戻せるか、インデックスを見る |
| `code-reviewer`、`security-reviewer` | PHP と Laravel の記述を外し、Workers、Hono、D1、R2、Svelte を前提にした。どちらも `multi-tenant.md` と `cloudflare-workers.md` を読む |
| `ui-reviewer` | 足した。画面の差分のコードを `docs/design.md` とチェックリストの `ui.md` に突き合わせ、色の役割、テーマ、言葉の切り替え、状態、アクセシビリティ、狭い幅での崩れを見る。撮った画像での採点は `screen-review` が受け持つ |
| `.claude/checklists/` | `cloudflare-workers.md` と `multi-tenant.md` を足した。`database.md` を D1 向けに書き直し、`languages/typescript.md` から使わないフレームワーク（Vue、Nuxt、Express、Sequelize）の節を外し、SvelteKit の節を SPA モード向けに直した |

### 新しく作るもの

作る順に並べる。

| スキル | 中身 | 時期 |
| --- | --- | --- |
| `d1-migration` | 戻せないマイグレーションを書く手順。列や表は先に足し、消すのは次の版以降にする（広げてから縮める）。マイグレーションを当てた後に `wrangler rollback` しても、古いコードが新しいスキーマで動くようにするため。共通の表か組織の中の表かの区分と、`data-model.md` を同じ PR で直すことも扱う | 最初のマイグレーションの前 |
| `add-operation` | 操作の定義を1つ足す型紙。定義、Hono のルート、権限のテスト、組織の分離のテスト、画面から呼ぶ口までを一続きで作る | 最初の API を作るとき |
| `screen-review` | 画面の自己レビュー（`HANDOFF.md` の「画面の自己レビューのスキル」） | 最初の数画面が動いてから |
| `incident` | 本番で壊れたときの手順。Workers Logs を読む、`wrangler rollback` で戻す、D1 の Time Travel を使う | 運用の手順書と一緒に |

クラウドのセッションで依存を入れる SessionStart のフックは、上の「Claude の設定とフック」にある。

## 開発の流れ

1. アイディアは `docs/ideas.md` か Issue に置く
2. `issue-plan` で Issue を書く。完了条件、触る領域、マイグレーションの有無を書く
3. 人が着手を決める
4. クラウドのセッションで実装する。テストは実装と一緒に書く
5. `self-review` で点検し、`pr-create` で PR を出す
6. CI と AI レビューを待ち、指摘には `pr-feedback` で応える
7. 下の「マージの判定」に従って、人がマージする。人の指示があれば、セッションがマージする
8. `main` から Workers Builds で自動でデプロイされる（下の「CD」）

仕様を変える実装は、同じ PR で `docs/` も直す。

### マージの判定

マージするかは人が決める。auto-merge は使わない（上の「`main` を守る仕組み」）。

人がその PR のマージを指示したときは、セッションが `gh pr merge <番号> --squash --match-head-commit <確かめた head>` でマージしてよい。打つ前に、`needs-human` が付いていないこと、その head で `label` と `ci-ok` が成功していることを確かめる（`ci-ok` が CI に入るまでは `label` だけ。手順は `pr-feedback` の「マージを依頼して後片付けする」）。`needs-human` の PR と `label` が成功していない PR は、指示があっても人がマージする。

フックは `gh pr merge` のたびに確認を挟み、`--auto` と `--admin`、`gh api` や `curl` でのマージ、`gh` のエイリアスの作成を止める。クラウドのセッションでは `gh pr merge` が GraphQL で 403 になるので、人がマージする。

次のどれかに触れた PR には、GitHub Actions（CI の `label`）が機械的に `needs-human` のラベルを付ける。AI には判断させない。パスの規則は `.github/labeler.yml` にある。各領域のコードは右の列の場所に置き、ほかの場所に散らさない。

| 領域 | 置き場所 |
| --- | --- |
| マイグレーション | `migrations/` |
| 認証と GitHub OAuth、暗号、シークレット | `src/server/auth/`、`src/server/crypto/`、`.dev.vars*` |
| 組織で絞る層（組織をまたぐデータの分離。Kysely の2つの入口と `batch()` の関数） | `src/server/db/` |
| 運用者の権限（運用者だけの操作の定義） | `src/shared/operations/operator/` |
| 取り込み元の処理（顧客のデータ） | `src/server/import/` |
| wrangler の設定（見本の Worker の `wrangler.design.jsonc` も含む）、デプロイのスクリプト、依存 | `wrangler*.jsonc` など、`scripts/`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`patches/`、`.npmrc`、Node の版の指定 |
| lint の設定（組織で絞る層を守る規則を含む） | `eslint.config.*` |
| GitHub と Claude の設定 | `.github/`、`.claude/settings.json`、`.claude/hooks/`、`.mcp.json` |

ファイルのリネームを含む PR と、変更したファイルが 3000 を超える PR にも付ける。パスの規則は移動先の名前しか見ず、変更したファイルの一覧も 3000 件までしか取れないため。

ラベルは付けるだけで、機械は外さない。人が外したときは、パスに当たっていれば付け直す。新しい領域を足すときや置き場所を変えるときは、`.github/labeler.yml` と上の表を同じ PR で直す。運用者の権限を確かめるコード（操作の定義を登録する関数）の置き場所は、入口を作る Issue（上の「初版の作る順」の3）で決め、この表に足す。

`needs-human` の PR は、AI レビューが通っていても人が差分を読んでからマージする。マイグレーションを含む PR では、このマージが本番に当てる承認になる（下の「CD」）。`label` のチェックが成功していない PR も、`needs-human` と同じに扱う（ジョブが落ちるとラベルが付かず、付いていない PR と見分けが付かないため）。付いていない PR は、`label` の成功を確かめたうえで、`ci-ok`、AI レビューの指摘、e2e のスクリーンショットを見て決めてよい。

この仕組みが守るのは PR を通る変更だけで、`main` への直接の push は止められない（上の「`main` を守る仕組み」）。

## CI

PR ごとに GitHub Actions で回す。

| ジョブ | 中身 |
| --- | --- |
| setup | 道具の版をリポジトリで固定し、ロックファイルどおりに依存を入れる |
| check | 型の検査（`tsc`、`svelte-check`）、lint、整形 |
| test | Workers の実行環境で動かす（`@cloudflare/vitest-pool-workers`）。ローカルの D1 に全マイグレーションを当てて回す。組織の分離のテストを含む |
| migration | 空の D1 に全マイグレーションを順に当てて通るか確かめる。ベータが始まったら、既にあるマイグレーションのファイルの書き換えも落とす（上の「DB を作り直してよい期間」） |
| e2e | ビルドして `wrangler dev` を立て、Playwright で主な流れを確かめる。4つのテーマと2つの言葉の組み合わせでスクリーンショットを撮り、成果物として上げる |
| ai-review | `anthropics/claude-code-action` で、スキル `ai-review` が差分に応じて `.claude/agents/` のレビューのエージェントを呼び分け、指摘を PR に書く。`.github/workflows/ai-review.yml` に分けて置く |
| label | パスを見て `needs-human` のラベルを付ける（上の「マージの判定」）。`.github/workflows/label.yml` に分けて置き、`pull_request_target` で動かす。ワークフローも規則も PR のベース（`main`）の版が使われるので、PR の側で書き換えてもラベルは付く。別のブランチをベースに開いてから `main` へ付け替えたときも、判定し直す。PR のコードはチェックアウトしない（書き込みのトークンで PR のコードを動かさないため） |
| ci-ok | ai-review と label を除く上のジョブをまとめる1つのジョブ。マージの前に確かめるのはこれだけ |

ai-review は Claude のサブスクリプションで動かす。手元で `claude setup-token` を実行して作った OAuth トークンを、リポジトリのシークレット `CLAUDE_CODE_OAUTH_TOKEN` に置く。従量の費用はかからないが、使用量の上限は手元の対話の利用と共有になる。

- 回すのは、`main` を base にしたドラフトでない PR を作ったとき（`opened`、`ready_for_review`、`reopened`）だけ。push のたびには回さない。直した後にもう一度見せたいときは、人が PR に `ai-review` のラベルを付ける。終わるとラベルは外れる。PR を作るときにはラベルを付けない（作成と付与で2回走る）
- 文書だけの PR（`docs/`、`.md`）、ドラフトの PR、fork と Bot（Dependabot など）の PR では回さない。そこへ付けた `ai-review` のラベルは外れずに残るので、回すときは外してから付け直す
- `ci-ok` に含めない。AI レビューは助言で、サブスクの上限で落ちてもマージの判定を止めない
- PR の上で action が読む `.claude/` と `CLAUDE.md` は、base のブランチのもの。スキルやエージェントの変更は `main` に入ってから効く
- GitHub への書き込みは、ワークフローのトークン（`contents: read`、`pull-requests: write`）で行う。Claude の GitHub App のトークンは `main` に書き込めるため使わない。Claude に許すコマンドは、その PR を読む `gh pr diff` と `gh pr view`、その PR に `--body` で書く `gh pr comment`、`git diff` などの読み取りで、`gh api` は許さない（任意の API と外部の URL を叩けるため）。許可は前方一致なので、`git diff --no-index` でランナーの上のファイルを読むことはできる。Claude が動かすコマンドの環境からは秘密情報を除き（`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`）、外へ送る道具は許さない。指摘は `github-actions[bot]` の名前で付く
- ワークフローは PR の head の版が動く。ワークフローを書き換える PR では、上の守り（ワークフローのトークン、許すコマンド、秘密情報の除去）も同じ PR の中で外せる。`.github/` に触れる PR は `needs-human` にし、人がワークフローの差分を読んでからマージする
- OAuth トークンは長く使え、額の上限を掛けられない。どのブランチにワークフローを置いても（PR の中でも、`on: push` でも）読めるので、リポジトリに push できる人とセッションには、レビューを経ずに読めると考える。漏れた疑いがあれば、`claude setup-token` で作り直してシークレットを入れ替える

確かめるチェックを `ci-ok` の1つにまとめるのは、文書だけの PR で重いジョブを飛ばしても、見る所が1つで済むようにするため。

GitHub Actions の無料枠は、private のリポジトリで月 2,000 分。e2e と AI レビューで足りなくなりそうなら、上と同じく対象の PR を絞る。

PR ごとのプレビュー環境は持たず、Workers Builds の preview builds も有効にしない。`wrangler versions upload` のプレビュー URL は本番と同じ D1 につながり、マージ前のコードが本番のデータに触れるため。見た目の確認は e2e のスクリーンショットで行う。

## CD

`main` への push で、Cloudflare の Workers Builds（Git との連携）が動く（2026-10-23 に決めた）。デプロイの鍵を GitHub に置かないため（上の「`main` を守る仕組み」）。

1. ビルドする
2. デプロイのコマンドで、リポジトリに置いたデプロイのスクリプトを動かす。スクリプトの手順は次のとおり
   1. マイグレーションがあれば `wrangler d1 migrations apply --remote` で当てる
   2. `wrangler versions upload` で新しい版を上げ、`wrangler versions deploy` で切り替える
   3. 煙のテストで `/api/health`（版と DB への疎通）を確かめる。落ちたら `wrangler rollback` で戻し、ビルドを失敗で終える
3. ビルドの失敗には、Cloudflare の通知と GitHub のコミットの状態で気づく。下の「本番で壊れたことに気づく」の定期の確認でも Issue が立つ

マイグレーションの承認は別に挟まない。マイグレーションを含む PR には `needs-human` が付き、人が差分を読んでマージするので、そのマージを承認とみなす。`main` への直接の push ではマイグレーションを入れない。

マイグレーションを当ててから版を切り替え、戻すときはコードだけを戻す。どちらの順でも動くように、マイグレーションは `d1-migration` の「広げてから縮める」に従う。

Workers Builds の API トークンは、権限を最小にしたものを自分で作って選ぶ。自動で作られるトークンは、D1、R2、KV、Queues の編集と、全ゾーンの Workers Routes の編集の権限まで持つため。見本の Worker をつないだとき（2026-10-23）、「Account API tokens」で作ったアカウントのトークンは Workers Builds の選択肢に出なかった。本番をつなぐ前に、「My Profile」で作るユーザーのトークンなら選べるかを確かめる。

文書だけの push でビルドを飛ばせるか（build watch paths）と、続けて push したときにビルドが一列に並ぶかは、土台を作るときに確かめる。

### 見本の Worker

見本（`design/`）を、開発者でない人に見せるための2つ目の Worker で配信する（2026-10-23 に決めた）。

- 設定はリポジトリのルートの `wrangler.design.jsonc`。`design/` を静的なファイルとして返すだけで、コード、D1、R2、シークレットを持たない。設定を `design/` の中に置くと設定そのものが配信されるので、外に置く
- URL は `https://scrum-guild-design.ucan-lab.workers.dev/`。URL の先頭は Worker の名前。名前はダッシュボードの Worker の設定（General の Name）で変え、設定の `name` も同じ名前にそろえる。Access のアプリは URL でなく Worker に付くので、名前を変えた直後から新しい URL を守り、古い URL は 404 を返した（2026-10-24、#17）。設定の `name` だけが先に変わっていた間も、Workers Builds はつないだ Worker へのデプロイを通した。`ucan-lab` はアカウントの `workers.dev` のサブドメインで、変えるとアカウントのすべての Worker の URL が変わる
- 本番と同じく Workers Builds が `main` から反映する。ビルドのコマンドは空で、デプロイのコマンドは `npx wrangler deploy -c wrangler.design.jsonc`。build watch paths は `design/*` と `wrangler.design.jsonc` だけにし、preview builds は有効にしない
- API トークンは、Workers Builds が自動で作ったもの（`team-leveling-design build token`。Worker の名前を変える前に作られた）を使っている。最小の権限のトークンを選べなかったため（上の「CD」）。本番の D1 や R2 を作る前に、最小の権限のトークンに入れ替える
- `workers.dev` の URL を Cloudflare Access（Zero Trust の無料の枠、50人まで）で守る。Access のアプリ（`scrum-guild-design - Cloudflare Workers`）は Worker の本番とプレビューの URL を覆い、セッションは1か月。ログインの手段は Cloudflare アカウントとワンタイム PIN。版ごとのプレビュー URL は設定の `preview_urls` で作らない
- 見る人を足すときは、Zero Trust の Access controls の Applications で見本の Worker のアプリを開き、メールアドレス（Emails）で許可する方針を足す。今の方針は Cloudflare アカウントのメンバーだけを許可する
- 指摘はチャットで受け取り、結論を `HANDOFF.md` の「確認してほしいこと」と `docs/design.md` に移す

## 本番で壊れたことに気づく

外部へのテレメトリは送らない方針のまま、自分たちで見る。

- Workers Logs を有効にする
- GitHub Actions の定期実行で、1時間ごとに本番の `/api/health` と定期処理の最後の成功時刻を確かめ、落ちていたら Issue を立てる
- Cloudflare の通知で Workers のエラー率などを受けられるかは、土台を作るときに確かめる

## GitHub のログインと取り込み

初版は要件のまま、ログインは共通の1つの GitHub OAuth App（`read:user` だけ）、取り込みは各自が発行する読み取り専用の fine-grained PAT にする（2026-10-22 に決めた）。

GitHub App も比べた。人が抜けても取り込みが止まらない、PAT の発行と更新の手間が消える、Webhook で取り込める、という利点がある。初版で選ばなかったのは次の理由から。

- 払う相手は受託や SES のチームで、リポジトリは発注元の組織にあることが多い。外部のアプリを入れるには発注元の管理者の承認が要る
- インストールは組織ごとに1つなので、2つの組織が同じ組織を使うと1つのインストールを共有する。読めるリポジトリは両方が選んだものの和になり、組織 A が組織 B のために選ばれたリポジトリを読めてしまう
- App の秘密鍵、インストールのトークンの発行、インストールと解除の Webhook が増え、最初の一本道が太くなる
- ログインの同意画面に「あなたに代わって操作する」旨が出て、本人確認だけという要件と見た目が合わない

ベータで「PAT が面倒」「人が抜けて止まった」が多ければ、取り込みだけ GitHub App に移す。そのときは、接続ごとにリポジトリの許可リストを持ち、インストールを組織に結ぶときに確かめる作りを合わせて入れる。

## 開発とテストでのログイン

ログインを飛ばす口は作らない（2026-10-22 に決めた）。本番に罠として残るコードを無くすため。

- seed が、決まったトークンのセッションをローカルの D1 に入れる。e2e と画面の自己レビューは、その Cookie を置いてログインした画面を開く。トークンは開発用の値で、本番の D1 には入れない
- テーマと言葉は、本物の設定の API（自分の設定、組織の設定）で切り替えてから撮る。撮影のための URL のパラメータは作らない
- 「今日」は、開発用の設定の値（wrangler の開発用の値）で固定できるようにし、スクリーンショットが日付で変わらないようにする。本番でこの値が設定されていたら起動を止める
- 開発用の GitHub OAuth App を別に作り、手で本物のログインを確かめるときに使う

## Issue の運用

- ラベル: 人が差分を読む `needs-human`、マイグレーションの `migration`、領域の `area:auth`、`area:organization`、`area:workspace`、`area:task`、`area:import`、`area:attachment`、`area:ui`、`area:infra`、`area:docs`、不具合の `bug`、AI レビューをもう一度回す `ai-review`。GitHub に作り、`bug` 以外の既定のラベルは消した（2026-10-22）。重複や対応しないものは、ラベルではなく Issue を閉じるときの理由で表す
- マイルストーン: 「初版」。自分のチームで使い始めるまでの Issue を入れる
- テンプレート: `.github/ISSUE_TEMPLATE/plan.md`。`issue-plan` が書く形（背景、やること、完了条件、確認方法、触る領域、マイグレーション）と同じにする
- 領域のラベルは、並行して作業するときのぶつかりを見分けるのにも使う。同じ領域の PR を同時に何本も開かない

## 運用の手順書

`docs/operations.md` の1つにまとめる（2026-10-22 に決めた）。最初のデプロイの PR で作り、手順を変える PR で同じ差分の中で直す。

- 用意: Cloudflare のアカウント、GitHub OAuth App、D1 と R2 のバケット、シークレットの一覧と登録、Workers Builds の接続と API トークン
- 出し方: Workers Builds とデプロイのスクリプト、マイグレーション、煙のテスト
- 戻し方: `wrangler rollback`、D1 の Time Travel、定期の書き出しからの戻し
- 組織: 作成、停止と再開、解約と30日後の消去（R2 のファイルを含む）
- 鍵の入れ替え: 接続の認証情報の暗号鍵
- 本番で壊れたとき: Workers Logs の見方、定期の確認の Issue が立ったときにすること

後で作る `incident` のスキルは、この文書の「戻し方」と「本番で壊れたとき」を手順として読む。

## セキュリティのヘッダー

最初の一本道から厳しく入れる（2026-10-22 に決めた）。後から締めると、壊れる所を探す手間が大きいため。

- CSP: SvelteKit の `csp` の設定（ハッシュ）で、`script-src` を自分のものだけにする。`default-src 'self'`、`object-src 'none'`、`base-uri 'self'`、`frame-ancestors 'none'`、`form-action 'self'` を基本にする。書体などで外を読むときは、その先だけを足す
- `X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`Strict-Transport-Security`
- API の応答にも同じヘッダーを付ける
- e2e で、CSP の違反が出ないことを確かめる

## 添付ファイルの配信

画面と同じオリジンから、Worker が権限を確かめて返す（2026-10-22 に決めた）。別のドメインと署名付き URL は使わない。

- 画面で表示するのは、決まった型の画像と動画（MP4、WebM）だけにする。型は上げたときの申告ではなく、ファイルの先頭のバイトで確かめる
- SVG と HTML を含め、それ以外はすべて `Content-Disposition: attachment` で落とす
- 添付ファイルの応答には `Content-Security-Policy: sandbox; default-src 'none'` と `nosniff` を付ける
- 決まりの外れは `.claude/checklists/cloudflare-workers.md` の「画面の配信」で見る

## Cloudflare のアカウントとドメイン

- 本番の Cloudflare アカウントは ucan-lab 用に新しく作る（2026-10-22 に決めた）。請求と権限を個人のものと分け、法人化や人を足すときに移しやすくする
- ドメイン `scrum-guild.dev` はベータの前に取る（2026-10-22 に決めた）。それまでは `workers.dev` の URL で動かす
- 本番の Worker の名前は `scrum-guild` で、ドメインを取るまでの URL は `https://scrum-guild.ucan-lab.workers.dev/`（2026-10-24 に決めた）。GitHub OAuth App の戻り先もこの URL にする
- アカウントは、本番に初めてデプロイする Issue（上の「初版の作る順」の2）で Workers Paid にする（2026-10-24 に決めた）。無料の枠は1回の CPU の時間や外への通信の回数の上限が厳しく、`wrangler dev` ではその上限で止まらないので、本番でだけ落ちる差を最初から無くすため
- 本番の `workers.dev` は Cloudflare Access で守らない（2026-10-24 に決めた）。アプリに GitHub のログインがあり、入れる組織か届いた招待が無い人は入れないため。Access を挟むと、煙のテストの `/api/health` を通す除外が要り、ドメインを移すときに Access のアプリも作り直すことになる
- ドメインへ移すときは、公開する URL の設定、GitHub OAuth App の戻り先、Cookie を直し、移した後にもう一度ログインしてもらう。手順は `docs/operations.md` に書く
- 組織を示す URL の形（`/<slug>/...`）は、`workers.dev` の上でも変えない

## 定期の作業

- 依存の更新は Renovate か Dependabot で週に1回、まとめて出す。`needs-human` が付くので、人が差分を読んでマージする
- `wrangler d1 export` の定期の書き出しは、顧客のデータなので GitHub の成果物に置かず、R2 の別のバケットに置く
