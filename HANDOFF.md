# 引き継ぎ

2026-10-22 時点。要件定義、データモデル、デザイン（原則、画面一覧、デザインシステム、初版の全画面の見本）まで進んだ。OSS をやめてサービスにし、稼働先を Cloudflare だけに絞った。開発の進め方（ブランチ、AI の分担、スキル、CI/CD）を決めた。実装はまだ始めていない。

## 文書と置き場所

| もの | 置き場所 |
| --- | --- |
| 要件定義 | `docs/requirements.md` |
| 名前の決定の記録 | `docs/naming.md` |
| サービスにする方針と進め方 | `docs/business.md` |
| AI の機能の案 | `docs/ai.md` |
| データモデル | `docs/data-model.md` |
| 開発の進め方（ブランチ、AI の分担、スキル、開発の流れ、CI/CD） | `docs/development.md` |
| AI への決まり（セッションが最初に読む） | `CLAUDE.md` |
| デザインの原則、画面一覧、主なフロー、決めた方向 | `docs/design.md` |
| デザインシステムと画面の見本 | `design/`。`design/index.html` をブラウザで開く（ビルド不要）。人に見せるときは見本の Worker（`https://team-leveling-design.ucan-lab.workers.dev/`、`docs/development.md` の「見本の Worker」） |
| スタイルタイル（見た目の3案。決定の記録） | `design/style-tiles.html` |
| 最初のモック（役目を終えたもの） | `mock/` |
| クラウドのセッションでも使うスキル、レビューのエージェント、そのチェックリスト | `.claude/skills/`、`.claude/agents/`、`.claude/checklists/`。原本は `ucan-lab/claude-skills`。GitHub の操作は REST（`gh api`）に書き換えてある。レビューのエージェントとチェックリストは、このリポジトリ向けに書き直したので原本と別物になっている（`docs/development.md` の「今あるもの」） |

## 確認してほしいこと

### 見本の全体

- [ ] 初版の全画面（カタログの「画面の見本」から開く19画面）を見て、足りない画面や情報がないか
- [ ] ゲームの言葉とスクラムの言葉を切り替えて、どちらでも崩れないか
- [ ] 4つの見た目（シンプルのライトとダーク、中世風、現代風）のどれでも読みやすいか。カタログの先頭か、画面の上の「テーマ」で切り替えられる
- [ ] 現代風の光の強さと、光らせる所（レベル、積載量、貼り紙、ダイアログ、クリアの演出だけ）がちょうどよいか
- [ ] シンプルの完了の印（緑の丸にチェック）とロゴの印（TL）でよいか
- [ ] 本来の書体（Zen Old Mincho、BIZ UDPGothic、IBM Plex Mono、Chakra Petch）での見え方。現代風の見出しは Chakra Petch が要になる。作った環境では Google Fonts を読み込めず、代わりの書体でしか確かめていない
- [ ] スマホ幅で崩れないか（PC が対象で、スマホは崩れない程度でよい）
- [ ] ダイアログ（スプリントの開始、延長、終了、起票、エピックの削除、完了の記録の修正、ワークスペースの作成、組織の作成、停止、管理者の指名し直し）の文言と選択肢
- [ ] クリアの演出（カタログの「ダイアログと演出」から見られる）の強さ

### 要件にない補い（`docs/design.md` の「見本を作って補ったこと」）

- [ ] ストーリーの詳細は別の画面にせず、エピックの画面の中に受け入れ基準と配下のタスクを並べる
- [ ] スプリントは最終日の前でも終えられる。最終日を過ぎたら終了を促す
- [ ] 受信箱でまとめて選んで、バックログへ入れたりアーカイブしたりできる
- [ ] 完了の記録を CSV で書き出せる（請求に使う想定）
- [ ] 配分の合計が100%を超えた月の知らせは、自分の設定の画面の先頭に出す
- [ ] 届いた招待は、ログインした直後と自分の設定の画面に出す
- [ ] 「完了の記録」を画面として持つ（要件定義では画面として書いていない）

### サービスにするための決めごと（`docs/business.md`）

- [x] 1つのアプリと1つの D1 に複数の組織を入れる（2026-10-21）。`docs/requirements.md` の「組織と運用者」と `docs/data-model.md` の `accounts`、`organizations`、`users` に反映した
- [x] 足りない画面の見本を作った（2026-10-21）: 組織の選択（`design/organizations.html`）、運用（`design/operator.html`）。ログイン、自分の設定の招待に組織の名前を足し、メニューの上に組織の切り替えを足した
- [ ] 添付ファイル（`docs/requirements.md` の「添付ファイル」、`docs/data-model.md` の `attachments`）。初版に入れ、タスク、ストーリー、エピック、コメントに付けると決めた（2026-10-22）。上限は1ファイル50MB、組織ごとに小さい組織 30GB、標準 100GB と決めた（2026-10-23 に値段の見直しで改めた）。動画（MP4、WebM）は画面で再生し、合計が80%を超えたら管理者に通知する
- [x] デザインの見本に、添付の欄、貼り付けた画像、動画の再生、上限に達したときの表示、80%の通知、管理者の設定の使用量、運用の画面の使用量と上限を足す（2026-10-22）
- [ ] 添付ファイルの見本（タスクの詳細、エピック、起票、組織の管理、運用、通知、カタログの「添付ファイル」）で、置き場所と文言がよいか。補ったことは `docs/design.md` の「見本を作って補ったこと」
- [ ] データベースの分け方（`docs/data-model.md` の「データベースの分け方」）。初めは1つの D1 で、足りなくなったら決まった数の D1 に組織を振り分ける。共通の表と組織の中の表を分け、結合しない、1回の `batch()` に混ぜない、という決まりでよいか
- [ ] 組織の選択と運用の画面で、出す情報と操作が足りているか。運用者が組織の中を見られない線引きでよいか
- [ ] 運用の画面の「停止」で、一時的な停止と解約（30日後に消す）を選ぶ形でよいか
- [ ] 顧客のデータ（private なリポジトリの課題や PR）を預かって運用してよいか
- [x] 取り込み元の本文は既定で預からず、組織の設定で保存を選べるようにした（2026-10-22）。`docs/requirements.md` の「取り込み」、`docs/data-model.md` の `organizations.stores_source_payload` と `task_source_payloads`
- [x] 組織の管理の見本（`design/admin.html`）に、取り込み元の応答を保存するかの設定を足した（2026-10-23）
- [x] 値段を見直した（2026-10-23）。組織ごとの定額を人数の段階（〜15人 月3,000円、〜50人 月10,000円）で分け、年払いは2か月分無料、お試しは30日。`docs/business.md` の「値段の考え方」、競合との比較は `docs/competitors.md`。組織に人数の上限（`docs/data-model.md` の `organizations.member_limit`）を足し、上限に達したら招待を止める
- [x] 運用の見本（`design/operator.html`）の上限の変更に人数の上限を足し、段階を 15人と30GB、50人と100GB に直した。招待の見本に上限に達したときの表示を足した（2026-10-23）
- [ ] 見積もりと実績の時間（予実）を詰める（`docs/requirements.md` の「未決の論点」）。工数の実績を Non-Goals から外した
- [ ] 適格請求書発行事業者に登録する時期を、税理士に確かめる（`docs/business.md` の「未決」）
- [x] スプリントを回さない保守中心のチームでも使えるよう、起票と詳細の経験値をタスクの完了で確定させ、感謝の回数の上限を週で数えるようにした（2026-10-23）。`docs/requirements.md` の「ゲームの仕組み」、`docs/data-model.md` の `xp_grants`
- [x] 見本の経験値の表示（`design/kit.js` の見込みの凡例、スプリントの終了のダイアログ、起票の欄の説明、`design/style-tiles.html` の見込み）から「スプリントの終了で確定」を外し、完了で確定する形に直した（2026-10-23）
- [x] Team Leveling は単体で動き、特定の取り込み元に依存しないと決めた（2026-10-23）。取り込み元に固有の処理と値は型の実装に閉じ、DB の CHECK にも書かない。種別は課題、PR、レビュー依頼に共通化した。Jira、Asana、Notion、GitLab、Bitbucket などは後回しで型を足す。同じ作業が別の取り込み元にあるときは、後回しの「取り込み元をまたいだ紐付け」で結び付ける
- [x] ログインの手段も差し替えられる型にし、アカウントを GitHub から切り離した（2026-10-23）。人は手段と手段の中の ID の組で見分け、`account_logins` で結ぶ。初版の手段は GitHub だけで、Google や Microsoft は後回し
- [x] 工数の実績とスケジュールのずれは Non-Goals に入れた（2026-10-23）
- [ ] 最初に声をかけるチーム

### 開発の進め方（`docs/development.md`）

- [x] ブランチ戦略、AI の分担、スキル、開発の流れ、CI/CD を決めた（2026-10-22）。squash merge だけ、承認は必須にせず人がマージを押す、PR ごとのプレビューは持たない、`main` へのマージで自動デプロイする
- [x] GitHub は無料のプランのまま進めると決めた（2026-10-23）。private ではブランチ保護、Rulesets、auto-merge、Environment が使えないので、すべての PR を人がマージし、デプロイは Cloudflare の Workers Builds で行う（鍵を GitHub に置かない）。マイグレーションの承認は `needs-human` の PR を人がマージすることで代える。`merge-risk` と自動マージはやめた。作業ブランチの名前は `<Issue番号>-<短い名前>` にした。`docs/development.md` の「`main` を守る仕組み」「マージの判定」「CD」
- [x] GitHub の設定を直した（2026-10-23）。マージ後にブランチを消す、squash のコミットの件名を PR のタイトルにし本文を空にする、ラベル `area:kingdom` を `area:organization` に改める
- [ ] Workers Builds をリポジトリにつなぎ、権限を最小にした API トークンを選ぶ。preview builds は有効にしない
- [ ] Cloudflare の通知で Workers のエラー率などを受けられるか
- [x] 技術の選択を決めた（2026-10-22）。pnpm、1つのパッケージ、ESLint と Prettier、SvelteKit の SPA モード、Kysely、zod、自前の操作の定義、型付きの言葉の辞書、seed とファクトリー。`docs/requirements.md` の「画面」を SvelteKit の SPA モードに改めた
- [x] 最初の一本道（組織の作成からタスクの完了まで）、DB を作り直してよい期間（ベータまで）、API のエラーの形、CI の AI レビュー（`claude-code-action`）を決めた（2026-10-22）。`docs/development.md` の「API のエラーとログ」「初版の作る順」
- [x] GitHub のログインと取り込み（初版は共通の OAuth App と各自の PAT）、開発とテストでのログイン（seed でセッションを作る）、Issue の運用を決めた（2026-10-22）。ラベル（`needs-human`、`migration`、`area:*`）とマイルストーン「初版」を GitHub に作り、`.github/ISSUE_TEMPLATE/plan.md` を置いた
- [x] CI の AI レビューを、API キーではなく Claude のサブスクリプションの OAuth トークンで動かすと決めた（2026-10-23、#8）。`docs/development.md` の「CI」
- [ ] Claude の GitHub App（https://github.com/apps/claude）をリポジトリに入れる
- [ ] 手元で `claude setup-token` を実行し、出たトークンをリポジトリのシークレット `CLAUDE_CODE_OAUTH_TOKEN` に置く
- [x] 運用の手順書（`docs/operations.md` に1つ）、セキュリティのヘッダー（最初の一本道から厳しく）、添付ファイルの配信（同じオリジンで型を絞る）、Cloudflare のアカウント（ucan-lab 用に新しく作る）を決めた（2026-10-22）
- [x] ucan-lab 用の Cloudflare アカウントを作った（2026-10-23）。Zero Trust を無料の枠で有効にし、チーム名を `ucan-lab`、ログインの手段にワンタイム PIN を足した
- [ ] Cloudflare アカウントを Workers Paid にする（本番を出すとき）
- [x] 見本の Worker を Workers Builds につなぎ、Access で守った（2026-10-23、#5）。アカウントの `workers.dev` のサブドメインを `ucan-lab` に改めた。GitHub の Cloudflare のアプリは `ucan-lab/team-leveling` だけに許可した
- [ ] 見本を見せる人のメールアドレスを、見本の Worker の Access のアプリの方針に足す（`docs/development.md` の「見本の Worker」）
- [ ] 見本の Worker の API トークンを、最小の権限のものに入れ替える。本番の D1 や R2 を作る前に行う。本番の Worker のトークンも同じ問題がある（`docs/development.md` の「CD」）
- [x] スキルとエージェントを整えた（2026-10-22）。`requirements` を外し、レビューのエージェント3つを D1 と Workers 向けに書き直し、チェックリストに `cloudflare-workers.md` と `multi-tenant.md` を足した

### AI の機能（`docs/ai.md`）

- [ ] `docs/ai.md` の「決めること」（初版に入れるか、経験値の扱い、顧客のデータを Anthropic に送ってよいか、モデル、値段）

### 片付け

- [ ] `mock/` を消してよいか（デザインシステムの見本で置き換えた）
- [x] マージ済みのリモートの作業ブランチ（`claude/*` の5本と `docs/task-repository`）を消した（2026-10-23）

### 名前の変更（scrum-quest から Team Leveling へ）

- [x] GitHub のリポジトリ名を `ucan-lab/scrum-quest` から `ucan-lab/team-leveling` に変えた（2026-10-20）。手元の作業コピーは `git remote set-url origin https://github.com/ucan-lab/team-leveling` で直す
- [ ] ドメイン `team-leveling.dev` を取る（2026-10-20 に空きを確かめた）。ベータの前に取ると決めた（2026-10-22）。それまでは `workers.dev` で動かす
- [x] claude.ai の Artifact に公開していた見本は消した（2026-10-20）。人に見せるのは見本の Worker に移した

## 次にやること

1. 上の確認の結果を `docs/design.md` と `docs/requirements.md` に反映する
2. リポジトリの土台を作る（`docs/development.md` の「技術の選択」。pnpm、Hono、SvelteKit の SPA モード、Kysely、zod、ESLint と Prettier、wrangler の設定、SessionStart のフック、`.claude/settings.json` の deny、CI の `ci-ok`、Workers Builds とデプロイのスクリプト）。ここから先、コードは PR を通す。`CLAUDE.md` の「コマンド」を埋める。SvelteKit の開発用サーバーと `wrangler dev` をどう組むか（1つにまとまるか、`/api` を転送するか）を確かめる
4. `d1-migration` のスキルを作り、`docs/data-model.md` から最初のマイグレーションを書く
5. `design/tokens.css` と `design/components.css` を本番の画面に持ち込み、`design/kit.js` の関数を1つずつ Svelte のコンポーネントにする。`html` の `data-theme` には、`users.theme`、なければ `organizations.theme` の値を入れる
6. 最初の数画面が Svelte で動いたら、下の「画面の自己レビューのスキル」を作る

## 画面の自己レビューのスキル

実装した画面を AI が自分で撮り、見て、採点し、悪い所から直すためのスキル。テーマ4つ、言葉2つ、画面幅2つで1画面16通りになり、人が全部を目で確かめるのは続かないので作る。

### 出典

hq の `04-research/x-seeconvm-opus-motion-design.md` の7章「The Critic」（二次情報）。記事はコードで描いた動画の話で、そのうち「描いた結果を AI 自身に見せて採点させ、ワースト3を直す」ループだけを画面の実装に持ち込む。

### 置き場所と時期

- このリポジトリの `.claude/skills/<名前>/SKILL.md`。team-leveling の画面と `docs/design.md` が前提なので、他のリポジトリと共有しない。
- 作るのは、最初の数画面が `wrangler dev` で動いてから。早く作るほど後の画面で得をする。

### 撮る組み合わせ

| 軸 | 値 |
| --- | --- |
| テーマ（`html` の `data-theme`） | `simple`、`simple_dark`、`medieval`、`modern` |
| 言葉 | ゲームの言葉、スクラムの言葉（見本では `design/kit.js` の `vocab`） |
| 画面幅 | PC、スマホ（スマホは崩れない程度でよい） |

テーマと言葉は、撮影の前に本物の設定の API で切り替える。ログインは seed のセッションの Cookie を置いて通し、「今日」は開発用の設定の値で固定する（`docs/development.md` の「開発とテストでのログイン」）。

### ループ

1. `terminal-browser` で対象の画面を組み合わせごとに撮影。撮る前に `innerWidth` を `eval` で確かめ、幅を揃えておく（ペインの倍率で CSS の幅がずれた実例がある）。
2. ImageMagick の `montage` で、1画面ぶんを1枚のコンタクトシートにする。
3. 同じ画面の見本（`design/*.html`）も同じ条件で撮り、並べて渡す。
4. 下の観点で 1〜10 点を付けさせ、悪い順に3つ、どの組み合わせのどこかと直し方を挙げさせる。採点は撮った画像だけを根拠にし、作ったつもりの内容で採点しない。
5. 3つを直して撮り直す。全観点が基準（例: 8点）に届くまで繰り返す。

### 採点の観点

`docs/design.md` の原則と「どのテーマにも共通すること」から取る。

- 見本との差（部品、余白、情報の並び）
- 文字のはみ出し、重なり、切れ。特に言葉を切り替えたとき
- 色の役割を守っているか（完了の色、印の色、経験値の色を他の意味に使っていないか）
- 状態の色をアイコンか文字と一緒に使っているか
- 現代風で光らせているのが要所（レベル、積載量、貼り紙、ダイアログ、クリアの演出）だけか
- スマホ幅で崩れていないか

### 演出の確認

クリアの演出、判子、トーストは、1枚では動きを見られない。Web Animations API でアニメーションを止め、`currentTime` を少しずつ進めて連続のコマを撮り、横に並べて見せる。見る点は次のとおり。

- 短く1回で終わるか
- 最後のコマで止まり、読める状態で残るか
- `prefers-reduced-motion` のときに止まるか

### 作らないもの

- 動画の書き出し。記事の本題（`seek(t)` で描いて MP4 にする）は、サービスの紹介動画を作る段階で別に考える。

## 覚えておくこと

- `main` に直接コミットしてよいのは、文書だけの変更に限る（`CLAUDE.md` の例外と同じ）。GitHub は無料のプランでブランチ保護が無いので、設定ではなく決まりとして守る（2026-10-23。`docs/development.md` の「`main` を守る仕組み」）。
- 名前は Team Leveling。表記の決まりは `docs/requirements.md` の「名前」、経緯と重なりの確認は `docs/naming.md`。
- 見本は、画面ごとの CSS を持たない決まり。足りない部品は先に `design/components.css` とカタログに足す。
- 見本の例のデータ（`design/sample-data.js`）はすべて架空。実在の名前を混ぜない。
- OSS にはせず、自分たちで運用するサービスにする。稼働先は Cloudflare だけ（2026-10-21 に決めた。経緯は `docs/business.md`）。
