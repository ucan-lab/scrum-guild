# 競合サービスの調査

状態: 調査。2026-10-23 に各社の公式の料金ページとヘルプで確かめた。価格は改定が多いので、値付けを決める前に出典で確かめ直す。

## 要点

- ゲームの仕組み（経験値、レベル、報酬）と、Backlog と GitHub の取り込みを両方持つサービスは見つからなかった。タスク管理の道具はどれもゲームの仕組みを持たず、ゲーム化の道具はどれも Backlog とつながらない。
- 組織ごとの定額で円建てなのは、Backlog、My Redmine、Planio だけ。ほかはユーザー単位で、多くはドル建て。
- 値付けに効く変化は次の2つ。
  - Backlog の 2027-01-01 のプラン改定。最安の有料プランが月 ¥21,000（15人）に上がり、フリーの上限は10人から5人に下がる。スターター（月 ¥2,700）は新しいプランの一覧に無い。既存の契約が新しいプランに移るのは、2027-01-01 以降の最初の更新日から。
  - Jooto の一般提供の終了（2027-07-31）。ヌーラボと Lychee が移行の窓口を出している。
- 〜50人の月 ¥10,000 は、My Redmine のスタンダード（1,000人まで月 ¥10,000）と同じ額。〜10人の月 ¥3,000 は、Jira Free と GitHub Free（どちらも無料）と並べられる。
- 経験値を「人の評価に使わない」とうたう製品は無い。devActivity は逆に人事評価の材料を売りにし、Jira のゲーム化アプリはランキングが中心。比べない設計をうたうのは、早期アクセス中の Questline だけ。

## 調べた対象

| 群 | 対象 |
| --- | --- |
| 開発チーム向けのタスク管理 | Jira、Linear、GitHub（Projects）、Asana |
| 汎用と国産 | Backlog、ClickUp、Notion、Trello、Jooto |
| Redmine 系 | Redmine 本体、My Redmine、Planio、RedmineUP Cloud、Lychee Redmine |
| ゲーム化 | Habitica（Group Plan）、Trophies と Collaboration Champion（Jira のアプリ）、devActivity（GitHub App）、Bonusly、HeyTaco、Unipos、Questline |

## 月額の比べ方（10人と50人）

年払いは月あたりに直した額。税は各社の表示のまま（多くは税抜）。

| サービス | 選んだプラン | 10人 月払い | 10人 年払い | 50人 月払い | 50人 年払い |
| --- | --- | --- | --- | --- | --- |
| Team Leveling（仮） | 組織の定額 | ¥3,000 | 未定 | ¥10,000 | 未定 |
| Backlog 現行 | 10人: スターター、50人: スタンダード | ¥2,700 | ¥2,565 | ¥16,000 | ¥15,200 |
| Backlog 2027〜 | 10人: エコノミー、50人: ビジネス | ¥21,000 | ¥19,950 | ¥36,300 | ¥34,485 |
| My Redmine | スタンダード | ¥10,000 | ¥10,000 | ¥10,000 | ¥10,000 |
| Planio | 10人: Gold、50人: Enterprise | ¥7,000 | 年払い無し | ¥54,000〜 | 年払い無し |
| Lychee Redmine | スタンダード（10人単位＋クラウド利用料） | 月払い無し | ¥14,000 | 月払い無し | ¥50,000 |
| Jira | Standard | ¥14,300 | ¥11,667 | ¥71,500 | ¥59,250 |
| Asana | Starter | ¥14,750 | ¥12,000 | ¥73,750 | ¥60,000 |
| Notion | ビジネス（GitHub の同期に要る） | ¥38,000 | ¥31,500 | ¥190,000 | ¥157,500 |
| Trello | Premium（タイムラインと CSV に要る） | $125 | $100 | $625 | $500 |
| Linear | Basic | 未確認 | $100 | 未確認 | $500 |
| ClickUp | Business（旧系統の表示） | $190 | $120 | $950 | $600 |
| GitHub | Team | $40 | $40 | $200 | $200 |
| Trophies（Jira のアプリ） | 単一プラン | $8 | 約 $6.7 | 約 $55 | 約 $46 |
| Collaboration Champion（Jira のアプリ） | 単一プラン | 無料 | 無料 | 約 $40 | 約 $33 |

無料で使える範囲は、Jira Free が10人、Trello Free が10人とボード10枚、Backlog のフリーが10人（2027 から5人）、Linear Free が課題250件まで、GitHub Free は人数の制限なし。

## 月払いと年払いの差

| サービス | 年払いの割引 | 支払いの形 |
| --- | --- | --- |
| Backlog | 5% | 月払いと年払い。2027 から銀行振込は年払いだけ |
| Jira | 約17〜18% | 年払いは人数の帯で年額が決まり、帯の中で人を足しても更新まで変わらない。Enterprise は年払いだけ |
| Asana | 最大18% | 月払いと年払い。返金しない |
| Notion | 約17%（ページの表示は「最大20%」） | 月払いと年払い |
| Trello | Standard 約17%、Premium 20% | Enterprise は年払いだけ |
| ClickUp | 30〜37%（旧系統） | 料金ページに2系統のプランが同時に載っていて、どちらが正式か分からない |
| Linear | 未確認 | Enterprise は年払いだけ |
| GitHub | 無し（年払いも同じ単価） | 日本の顧客には消費税10%を課す |
| My Redmine | 無し | 6か月か12か月の前払いが基本。銀行振込の毎月払いは月 ¥1,500 上乗せ、口座振替は月 ¥400 引き |
| Planio | 無し | 月ごとの契約だけ |
| Lychee Redmine | 割引の記載無し | 6か月か12か月の契約だけ。クレジットカードの月払いは20%上乗せ |
| RedmineUP Cloud | 約17%（2か月分無料） | 月払いと年払い |
| Jooto | スターター約17%、ビジネス約25% | 2027-07-31 に終了 |
| Jira のアプリ | 約17%（年額は月額の10か月分） | Atlassian の契約に合わせる |
| Bonusly | 約17%（2か月分無料） | 料金ページは月払いを表示するが、FAQ は「全プラン年払い、最低1年」 |
| Habitica、HeyTaco | 年払い無し | 月払いだけ |

## サービスごとのプランの差

どのプランから何が使えるかのうち、こちらの機能と比べるのに要る点だけを挙げる。

### Backlog

| 項目 | 現行 | 2027〜 |
| --- | --- | --- |
| プラン（月払い、税抜） | フリー ¥0、スターター ¥2,700、スタンダード ¥16,000、プレミアム ¥27,000、プラチナ ¥75,000 | フリー ¥0、エコノミー ¥21,000、ビジネス ¥36,300、プロフェッショナル ¥100,000 |
| 人数とプロジェクト | フリー 10人・1、スターター 30人・5、スタンダード以上は人数無制限 | フリー 5人、エコノミー 15人・30、ビジネス以上は無制限 |
| ガント、バーンダウン、予定と実績の時間 | スタンダードから | エコノミーから。プロジェクト横断のガントはビジネスから |
| 孫課題、カスタム属性 | プレミアムから | ビジネスから |
| AI アシスタント | プレミアムから | ビジネスから（無償枠＋追加は有料） |
| SAML、監査ログ | Nulab Pass（別料金） | ビジネスから Nulab Pass |
| Git、SVN、API | 全プラン | 全プラン |

GitHub との連携は公式の一覧に無い。無料のお試しは30日（プラチナの機能）。

### Jira

- Free: 10人、ストレージ 2GB、自動化は月150回、権限のロールが無い（全員が管理者）、AI 無し。
- Standard から: ロールと権限、課題ごとのセキュリティ、サイトの監査ログ、ストレージ 250GB、自動化は1人あたり月400回。
- Premium から: 複数チームの計画、キャパシティ、IP の許可リスト。
- Enterprise: ユーザー操作の監査ログ。SAML SSO は Enterprise に込みで、それ以外は別料金の Guard が要る。
- スプリント、ポイント、ベロシティ、時間の記録、CSV の書き出し（1回1万件まで）は、プランの制限がヘルプに書かれていない。GitHub のアプリは無料。

### Linear

- Free: 課題250件、チーム2つ。
- Basic: チーム5つ、課題は無制限。
- Business から: 分析（Insights）、非公開のチーム、ゲスト、Triage のルール。
- Enterprise: SAML、SCIM、監査ログ、ダッシュボード。
- サイクル（スプリント）、ポイント、エクスポート、API は全プラン。GitHub の PR の状態で課題が自動で動く。時間の記録と日本語の画面は確認できなかった。

### GitHub

- Projects は全プランで使える。ポイントとスプリントは数値の項目とイテレーションで代用し、ベロシティは無い。
- Team は非公開のリポジトリで必須レビュアーなどが使える。SAML と SCIM は Enterprise。
- 画面は英語だけ。時間の記録は無い。

### Asana

- Personal: 2人まで。
- Starter から: タイムライン、ガント、ダッシュボード、自動化（回数無制限）。
- Advanced から: ゴール、ポートフォリオ、承認、時間の記録、Jira との双方向の同期。
- Enterprise: SAML、SCIM。
- スプリントとポイントの専用の機能は確認できなかった。

### ClickUp

- Free: ストレージ 60MB、自動化は月100回。人数は無制限。
- 上のプランほど、スプリントポイント、ダッシュボード、時間の記録とタイムシート、書き出し、自動化の回数が増える。Google SSO は Business から、SAML と監査ログは Enterprise から。
- GitHub の連携は全プラン、GitHub を使う自動化は Business から（ヘルプが古い可能性がある）。

### Notion

- フリー: 2人以上だとブロック数に上限、ページ履歴7日。
- ビジネスから: GitHub と Jira の一方向の同期（同期した項目は読み取り専用）、SAML SSO、AI エージェント。
- エンタープライズ: SCIM、監査ログ。
- スプリントとポイントはテンプレートのデータベースで自分で組む。時間の記録は無い。

### Trello

- Free: 10人、ボード10枚、自動化は月250回。
- Standard: 自動化は月1,000回。
- Premium から: タイムライン、ダッシュボード、CSV の書き出し、自動化は無制限。
- Enterprise: 組織全体の権限。SAML は別料金の Guard。
- スプリント、ポイント、時間の記録は本体に無く、Power-Up で足す。

### Redmine 系

- Redmine 本体（GPL v2、自分で立てる）: チケット、ワークフロー、ガント、時間の記録と CSV、Git などとの連携、REST API、日本語。スプリントとポイントはプラグイン（RedmineUP Agile。Light は無料、PRO は $499〜）。
- My Redmine: 全プランで、プロジェクト無制限、API、GitHub 連携（Webhook）、2要素認証、IP 制限、アクセスログ。SAML はエンタープライズ（月 ¥28,000）から。プラグインは持ち込めない。データは国内。
- Planio: 人数とプロジェクト数で段階が上がる（Gold 10人・7プロジェクト、Platinum 45人・40プロジェクト）。全プランで Git と SVN、アジャイルのボードとバーンダウン。
- RedmineUP Cloud: 全プランに有料プラグイン一式（Agile PRO、Helpdesk、Invoices など）。Git 連携は Business から。
- Lychee Redmine: スタンダードからガント、バックログ、カンバン、AI、SAML。工数、リソース、EVM、コストの管理はプレミアムから。

### ゲーム化の道具

| 製品 | ゲーム化するもの | 価格 | ランキング |
| --- | --- | --- | --- |
| Habitica Group Plan | 家事や小さなプロジェクトのタスク。経験値、レベル、装備、承認制のタスク | 月 $9＋1人 $3 | 確認できなかった |
| Trophies | Jira と Confluence の操作。ポイント、実績、贈る賞 | 上の表 | 日、週、月、年、通算の単位。参加者を選べる |
| Collaboration Champion | Jira の課題の作成、完了、コメント。5段階のレベル、バッジ | 10人まで無料 | 個人とチーム |
| devActivity | GitHub のコミット、PR、レビュー。経験値、レベル、実績 | Free は7人まで、Premium は1人 $10 か $20（ページに両方あり） | あり。人事評価の材料も出す |
| Bonusly | 同僚への称賛ポイント。月の付与枠、報酬に交換 | 1人 $3〜5 | 確認できなかった |
| HeyTaco | Slack と Teams での称賛。1日5個の上限、レベル、クエスト | 1人 $3〜5 | あり（変えられる） |
| Unipos | 称賛の投稿と拍手。週の上限、換金 | 公式は非公開 | 確認できなかった |
| Questline | プロジェクト管理に経験値、連続記録、クラス | 1人 €7.20〜（年払い） | 比べない連続記録をうたう |

## 機能の差

○ は本体にある、△ はプランか追加機能に依る、× は無い、? は確認できなかった。

| 機能 | Team Leveling | Backlog | Jira | Linear | GitHub | Asana | Notion | Trello | Redmine 系 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| スプリントとポイント | ○ | △ バーンダウンだけ | ○ | ○ | △ 代用 | ? | △ 自分で組む | △ Power-Up | △ プラグイン |
| エピック | ○ | △ 親子課題 | ○ | ○ | △ | △ | △ | × | △ |
| ガント | × | △ | ○ | × | △ ロードマップ | △ | △ タイムライン | △ | ○ |
| 時間の記録 | × | △ | ○ | ? | × | △ | × | △ | ○ |
| 完了の記録を区分と月で書き出す | ○ | × | × | × | × | × | × | × | × |
| Backlog の取り込み | ○ | 取り込み元 | × | × | × | × | × | × | × |
| GitHub の PR とレビュー依頼の取り込み | ○ | × | △ PR の表示 | ○ | 取り込み元 | △ PR の同期 | △ | △ 添付 | △ コミット |
| ロールと権限、監査ログ | △ ロールだけ | △ | △ | △ | △ | △ | △ | △ | ○ |
| 自動化 | × | △ | ○ | ○ | ○ Actions | ○ | △ | ○ | × |
| ゲームの仕組み | ○ | × | × | × | × | × | × | × | × |
| 日本語の画面 | ○ | ○ | ○ | ? | × | ○ | ○ | ○ | ○ |
| 円建ての定額 | ○ | ○ | × | × | × | × | × | × | ○ |

Team Leveling の欄は `requirements.md` の初版の機能から付けた。

## Team Leveling にとっての示唆

### 欠けている機能の候補

`ideas.md` の「必須と言える機能が欠けていれば取り入れる」の材料。

- 時間の記録: 受託と SES の請求の根拠では、Redmine 系と Jira が工数を記録して作業の分類ごとに CSV で出すのが定番になっている。Team Leveling の「記録」は何をいつ終えたかを残し、時間を持たない。想定顧客の請求が成果物の単位か工数の単位かで、必須かどうかが分かれる。
- ガント: Backlog（エコノミーから）、Jira、Redmine 系が持つ。受託の顧客へ見せる計画の資料として求められる可能性がある。
- 権限と監査ログ、IP 制限: どの競合も上のプランの売りにしている。セキュリティチェックシートで問われる項目と重なる（`business.md` の「事業にするときに要るもの」）。

### 値付け

- 〜10人の月 ¥3,000 は、Jira Free と GitHub Free の無料、Backlog の現行スターターの月 ¥2,700 と比べられる。Backlog の新プランが始まると、15人以下で Backlog を使い続けるには月 ¥21,000 かかる。
- 〜50人の月 ¥10,000 は My Redmine と同じ額で、My Redmine は1,000人まで使える。人数の段階で価値を説明しにくい。
- 取り込み元の Backlog を使い続けるチームには、Backlog の料金に上乗せになる。Backlog から乗り換える先として売るのか、Backlog と GitHub の上に重ねる道具として売るのかで、比べられる相手が変わる。
- 年払いの割引は、多くが約17%（12か月分を10か月分の値段にする形）。Backlog は5%と小さい。

## 確信度の低い点

- ClickUp の料金ページに2系統のプラン（Unlimited と Business、Core と Business と Max）が同時に載っていて、どちらが正式か分からない。
- Linear の月払いの価格、無料のお試し、日本語の画面、時間の記録は確認できなかった。
- GitHub の年払いの「for the first 12 months」の注記の中身は確認できなかった。
- Notion の円の価格が税込か税抜かは書かれていない。
- devActivity の Premium は $10 と $20 の両方がページにある。Bonusly は月払いの表示と、FAQ の「最低1年の年払い」が食い違う。
- Unipos の価格は比較サイトの掲載による。週の上限は古い記事による。
- Backlog のスターターが 2027 以降にどう扱われるかは明言されていない。新しいフリーの5人以外の上限も確認できなかった。
- Jira と Collaboration Champion の50人の月額は、1人あたりの単価から計算した。
- 「ゲームの仕組みが無い」は、公式の料金ページと機能比較に書かれていないという意味で、製品の中までは確かめていない。

## 出典

確認日はすべて 2026-10-23。

- Backlog: https://backlog.com/ja/pricing/ 、https://backlog.com/ja/blog/new-plans-2027/ 、https://backlog.com/ja/service-document/new-plans-2027.pdf
- Jira: https://www.atlassian.com/software/jira/pricing （ページに埋め込まれた料金データ。円の価格は 2026-10-13 版）
- Linear: https://linear.app/pricing 、https://linear.app/docs/billing-and-plans 、https://linear.app/docs/github
- GitHub: https://github.com/pricing 、https://docs.github.com/en/get-started/learning-about-github/githubs-plans
- Asana: https://asana.com/ja/pricing
- ClickUp: https://clickup.com/pricing
- Notion: https://www.notion.com/ja/pricing 、https://www.notion.com/help/github
- Trello: https://trello.com/pricing 、https://trello.com/ja/pricing
- Jooto: https://www.jooto.com/ 、https://www.jooto.com/pricing/
- Redmine: https://www.redmine.org/projects/redmine/wiki/Features
- My Redmine: https://hosting.redmine.jp/ 、https://hosting.redmine.jp/service/payment/
- Planio: https://plan.io/pricing
- RedmineUP: https://redmineup.com/pages/pricing 、https://www.redmineup.com/pages/plugins/agile/pricing
- Lychee Redmine: https://lychee-redmine.jp/plan/
- Habitica: https://github.com/HabitRPG/habitica （価格と文言の定義。公式サイトは本文を取得できなかった）
- Trophies: https://marketplace.atlassian.com/apps/1223472/trophies-gamification-for-jira
- Collaboration Champion: https://marketplace.atlassian.com/apps/1235193/collaboration-champion-for-jira
- devActivity: https://devactivity.com/pricing
- Bonusly: https://bonusly.com/pricing
- HeyTaco: https://www.heytaco.com/pricing
- Unipos: https://saas.imitsu.jp/sv-0594/price （公式は価格を載せていない）
- Questline: https://questline-forge.lovable.app/pricing
