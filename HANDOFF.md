# 引き継ぎ

2026-10-20 時点。要件定義、データモデル、デザイン（原則、画面一覧、デザインシステム、初版の全画面の見本）まで進んだ。実装はまだ始めていない。

## 文書と置き場所

| もの | 置き場所 |
| --- | --- |
| 要件定義 | `docs/requirements.md` |
| 名前の決定の記録 | `docs/naming.md` |
| データモデル | `docs/data-model.md` |
| デザインの原則、画面一覧、主なフロー、決めた方向 | `docs/design.md` |
| デザインシステムと画面の見本 | `design/`。`design/index.html` をブラウザで開く（ビルド不要） |
| スタイルタイル（見た目の3案。決定の記録） | `design/style-tiles.html` |
| 最初のモック（役目を終えたもの） | `mock/` |

見本は claude.ai の Artifact にも公開してある（非公開。持ち主のアカウントでだけ開ける）。

- カタログと全画面: https://claude.ai/artifact/V18YAuNMU83vzopPifJet1
- 自分の今日: https://claude.ai/artifact/FiCW7FnB1z9CoJZRF3ej4V
- スタイルタイル: https://claude.ai/artifact/U3hvppHQiC4kWiJdTfXXVg

## 確認してほしいこと

### 見本の全体

- [ ] 初版の全画面（カタログの「画面の見本」から開く17画面）を見て、足りない画面や情報がないか
- [ ] ゲームの言葉とスクラムの言葉を切り替えて、どちらでも崩れないか
- [ ] 4つの見た目（シンプルのライトとダーク、中世風、現代風）のどれでも読みやすいか。カタログの先頭か、画面の上の「テーマ」で切り替えられる
- [ ] 現代風の光の強さと、光らせる所（レベル、積載量、貼り紙、ダイアログ、クリアの演出だけ）がちょうどよいか
- [ ] シンプルの完了の印（緑の丸にチェック）とロゴの印（TL）でよいか
- [ ] 本来の書体（Zen Old Mincho、BIZ UDPGothic、IBM Plex Mono、Chakra Petch）での見え方。現代風の見出しは Chakra Petch が要になる。作った環境では Google Fonts を読み込めず、代わりの書体でしか確かめていない
- [ ] スマホ幅で崩れないか（PC が対象で、スマホは崩れない程度でよい）
- [ ] ダイアログ（スプリントの開始、延長、終了、起票、エピックの削除、完了の記録の修正、ワークスペースの作成）の文言と選択肢
- [ ] クリアの演出（カタログの「ダイアログと演出」から見られる）の強さ

### 要件にない補い（`docs/design.md` の「見本を作って補ったこと」）

- [ ] ストーリーの詳細は別の画面にせず、エピックの画面の中に受け入れ基準と配下のタスクを並べる
- [ ] スプリントは最終日の前でも終えられる。最終日を過ぎたら終了を促す
- [ ] 受信箱でまとめて選んで、バックログへ入れたりアーカイブしたりできる
- [ ] 完了の記録を CSV で書き出せる（請求に使う想定）
- [ ] 配分の合計が100%を超えた月の知らせは、自分の設定の画面の先頭に出す
- [ ] 届いた招待は、ログインした直後と自分の設定の画面に出す
- [ ] 「完了の記録」を画面として持つ（要件定義では画面として書いていない）

### 片付け

- [ ] `mock/` を消してよいか（デザインシステムの見本で置き換えた）
- [ ] GitHub でリモートの作業ブランチ `claude/focused-wright-vdqz0g` を消す（内容はすべて `main` に入っている。手元のブランチは消した。作業した環境からはリモートのブランチを消せなかった）

### 名前の変更（scrum-quest から Team Leveling へ）

- [x] GitHub のリポジトリ名を `ucan-lab/scrum-quest` から `ucan-lab/team-leveling` に変えた（2026-10-20）。手元の作業コピーは `git remote set-url origin https://github.com/ucan-lab/team-leveling` で直す。Claude Code のクラウドのセッションは、新しい名前で始め直すまで古い URL（GitHub が転送する）で push する
- [ ] ドメイン `team-leveling.dev` を取る（2026-10-20 に空きを確かめた）
- [ ] claude.ai の Artifact に公開した見本は古い名前のまま。必要なら公開し直す

## 次にやること

1. 上の確認の結果を `docs/design.md` と `docs/requirements.md` に反映する
2. リポジトリの土台を作る（Hono、Svelte、Vite、wrangler の雛形、Docker の雛形、稼働先のアダプター）
3. `docs/data-model.md` から最初のマイグレーションを書く
4. `design/tokens.css` と `design/components.css` を本番の画面に持ち込み、`design/kit.js` の関数を1つずつ Svelte のコンポーネントにする。`html` の `data-theme` には、`users.theme`、なければ `kingdom.theme` の値を入れる

## 覚えておくこと

- コミットは `main` に直接入れてよい（このセッションで決めた）。
- 名前は Team Leveling。表記の決まりは `docs/requirements.md` の「名前」、経緯と重なりの確認は `docs/naming.md`。
- 見本は、画面ごとの CSS を持たない決まり。足りない部品は先に `design/components.css` とカタログに足す。
- 見本の例のデータ（`design/sample-data.js`）はすべて架空。公開前の点検で、実在の名前が混ざっていないかを見る。
