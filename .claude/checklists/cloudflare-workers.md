# Cloudflare Workers

1つの Worker に、API（Hono、`/api/*`）、画面の配信（Workers Static Assets）、定期処理（Cron Triggers）をまとめている。DB は D1、添付ファイルは R2。決まりは `docs/requirements.md` の「技術の前提」と「運用」。

## 実行環境

- モジュールの最上位の変数に、リクエストごとの値（利用者、組織、リクエストの中身）を置いている。同じ isolate の別のリクエストと共有される
- 応答を返した後に続ける処理を `ctx.waitUntil()`（Hono では `c.executionCtx.waitUntil()`）に渡していない。待たない Promise は途中で打ち切られることがある
- 添付ファイルを `arrayBuffer()` や `text()` で丸ごと読んでいる（Worker のメモリには上限がある。`request.body` のストリームを R2 の `put()` へ流す）
- 1回のリクエストや定期処理で、件数の決まらないループの中から外部や D1 を呼んでいる（サブリクエストの数と CPU 時間に上限がある。定期処理は設定値の上限で区切り、続きは次の回に回す）
- Node.js の API を、`nodejs_compat` の設定を確かめずに使っている

## 設定と秘密

- 秘密の値をソースや wrangler の設定に直書きしている（Workers のシークレットに置き、`env` から読む）
- `.dev.vars` を git の対象にしている
- 秘密の値が未設定のとき、既定値で動き続ける（起動時か最初の使用時に止める）
- 公開する URL を設定から読まず、リクエストの `Host` から組み立てている（OAuth の戻り先と Origin の検査は設定の URL を使う）
- wrangler の設定を変えたのに、運用の手順書や `docs/` が追従していない
- `observability` を有効にしたのに `logs.invocation_logs: false` が無い（呼び出しごとのログが URL のパスとクエリを残し、OAuth の `code` や招待の秘密を URL で受けるとログに残る）
- wrangler の設定に `send_metrics: false` が無い（`.claude/settings.json` の `WRANGLER_SEND_METRICS` は Claude のセッションにしか効かず、人の手元と Workers Builds ではテレメトリが送られる）

## 乱数と暗号

- ID、トークン、セッション ID、state、PKCE に `Math.random()` を使っている（`crypto.getRandomValues()` や `crypto.randomUUID()` を使う。主キーは UUIDv7）
- 秘密の値やハッシュを `===` で比べている（`crypto.subtle.timingSafeEqual()` を使う）
- 接続の認証情報を暗号化せずに D1 に入れている。暗号文に鍵の版が付いていない

## 外への通信

- 取り込み元（Backlog、GitHub）と GitHub のログイン以外へ通信している（テレメトリは送らない。AI の機能を入れたら Anthropic が加わる。`docs/ai.md`）
- `fetch()` にタイムアウトが無い（`AbortSignal.timeout()` を渡す）
- 取り込み元の応答を、型を検証せずに使っている。大きさを確かめずに D1 に入れている
- 利用者が指定した URL へサーバーから通信している（SSRF）

## Hono

- 入力をバリデーターで検証せず、`c.req.json()` や `c.req.param()` の値をそのまま使っている
- `app.onError` で、内部のエラーの詳細（スタック、SQL、D1 のエラーの文）を応答に出している
- 認証や組織を確かめるミドルウェアを、対象のルートより後に登録している。ミドルウェアのパスの指定から、守るべきルートが漏れている
- ミドルウェアで `await next()` を忘れている、`next()` の後の処理が応答を書き換えられない形になっている
- 更新系の API（POST、PUT、PATCH、DELETE）で Origin ヘッダーを検査していない
- レート制限を、ログインと手動の同期に掛けていない

## 画面の配信

- `/api/*` の存在しないパスが、SPA の `index.html` で 200 を返している（API は JSON の 404 を返す）
- 画面と API の版がずれたときに、画面の再読み込みを促す作りが無い
- 添付ファイルを、利用者が上げた Content-Type のまま同じオリジンで返している（HTML や SVG がスクリプトとして動く。`Content-Disposition: attachment` か、表示してよい型だけに絞る）

## 定期処理

- 同じ処理が2回走ったときに、二重に取り込む、二重に経験値を付ける（何度走っても同じ結果になるようにする）
- 日をまたぐ判定を UTC で行っている（各ワークスペースのタイムゾーンで判定する）
- 1つの組織やワークスペースの失敗で、残りの処理が止まる
