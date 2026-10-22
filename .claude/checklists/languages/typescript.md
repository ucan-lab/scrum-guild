対象の拡張子: .ts .tsx .mts .cts .js .jsx .mjs .cjs .vue .svelte

# TypeScript / JavaScript

## 一般

- 処理されない Promise の reject、空の `catch`
- `array.forEach(async fn)` は完了を待たない（`for...of` か `Promise.all` にする）
- try の中で await せずに `return promise` していて、reject が catch に入らない
- デバッグ用の `console.log` が残っている
- 外部への HTTP 呼び出しにタイムアウトが無い
- コンポーネントの CSS で `prefers-reduced-motion` のときに `animation: none` にする要素に、キーフレームで変えていた `opacity` や `transform` の静止時の値が通常のルールに無い（止めると初期値の `opacity: 1` などに戻り、フェードで見え隠れさせていた光や重ねた要素が最大の強さで出たままになる）

## セキュリティ

- `innerHTML`、`dangerouslySetInnerHTML`、Vue の `v-html` にユーザー由来の値を入れている（`textContent` にするか DOMPurify を通す）
- リクエストの body や params をスキーマで検証せずに使っている
- `fetch(userProvidedUrl)` のように、ユーザーが指定した URL へサーバーからリクエストしている（SSRF）
- `child_process.exec` にユーザー入力を渡している（`execFile` か `spawn` を shell 無しで使い、ユーザー入力の引数の前に `--` を置く）
- 内部エラーの詳細をそのままクライアントに返している
- `{"__proto__": ...}` を含む入力を再帰的な merge に通している（グローバルの prototype が汚染される。`Object.assign` でも対象オブジェクトの prototype は差し替わる。`__proto__`、`constructor`、`prototype` のキーを弾くか、スキーマで検証する）

## DB

- ループの中でクエリを発行している（N+1）
- 利用者向けのエンドポイントに `LIMIT` の無いクエリがある

## Vue 3

- `reactive()` の戻り値を分割代入してリアクティビティを失っている（失うのはプリミティブのプロパティだけで、ネストしたオブジェクトはリアクティブのまま。`toRefs` を使う。3.5 以降の `defineProps` の分割代入はリアクティブなので対象外）
- `watch(state.count, ...)` のように、reactive のプロパティを値のまま監視対象に渡している（`() => state.count` にする）
- props のオブジェクトの中身を子コンポーネントで書き換えている（最上位でないと警告が出ないので気づきにくい）
- 同じ要素に `v-if` と `v-for` を置いている（Vue 3 では `v-if` が先に評価され、ループ変数を参照できない）

## Nuxt 3

- composable のファイルで、関数の外に `ref()` を置いている。サーバーでは全リクエストで共有され、別の利用者のデータが混ざる（`useState` を使う）
- 秘密の値を `runtimeConfig.public` に入れている（クライアントに配信される）
- setup の中で `$fetch` を直接呼んでいる。サーバーとクライアントで2回取得される（`useFetch` か `useAsyncData` を使う）
- 自作の composable の中で、`await` のあとに Nuxt の composable（`useNuxtApp`、`useRuntimeConfig` など）を呼んでいる（コンテキストが失われる。`<script setup>` の直下なら await のあとでも保たれる）
- イベントハンドラの中で `useFetch` や `useAsyncData` を呼んでいる（setup で呼ぶ前提の API。ハンドラの中では `$fetch` を使う）

## Svelte 5

- `$state` のオブジェクトを分割代入してリアクティビティを失っている（失うのはプリミティブの値だけで、ネストしたオブジェクトは proxy のまま）
- 他の state から計算できる値を `$effect` の中で代入している（`$derived` を使う。`$effect` の中で読んだ state に書き込むと無限ループになる）
- `$effect` の中で `await` や `setTimeout` のあとに読んだ値（依存として追跡されず、変わっても再実行されない）
- 通常の `.ts` ファイルで runes を使っている（`.svelte.ts` か `.svelte.js` でないと動かない）
- `{@html}` にユーザー由来の値を出している

## SvelteKit 2

- サーバー側のモジュールの最上位に置いた変数へのリクエストごとの値の保存（全利用者で共有される）
- `+page.ts` や `+layout.ts` で秘密の値や DB を扱っている（universal load はクライアントでも動く。`+page.server.ts` に置く）
- `+page.server.ts` の load が返す値は、すべてクライアントに渡る。不要な列や秘密の値が含まれていないか
- 認可を `+layout.server.ts` だけでしている（form action より前には走らず、`+server.ts` では実行されず、クライアント遷移では再実行されないことがある。`hooks.server.ts` か各 `+page.server.ts` で確かめる）
- `redirect()` と `error()` は例外を投げるので、囲んだ `try/catch` に握りつぶされる（`isRedirect` と `isHttpError` で投げ直す）
- load の中でグローバルの `fetch` を使っている（引数で渡される `fetch` を使う）
- 秘密の値を `PUBLIC_` 付きの環境変数に入れている
- `csrf.checkOrigin: false`（非推奨）や `csrf.trustedOrigins: ['*']` で origin の検査を無効にしている
- Vercel のサーバーレス関数で、レート制限やキャッシュをメモリ上の変数に持っている（インスタンスをまたいで共有されない）

## Express 4

- async のルートハンドラやミドルウェアで reject した例外が `next()` に渡らない。未処理の reject になり、Node 15 以降はプロセスごと落ちる（`try/catch` で `next(err)` するか、ラッパーで包む。Express 5 では不要）
- 引数が4つでないエラーハンドラ（`fn.length` で判定されるので、`(err, req, res, next)` の形で、`next = () => {}` のような既定値も付けない。既定値があると3引数と見なされる）
- `res.json()` や `res.redirect()` のあとの `return` 漏れ（処理が続き、後続でもう一度送信すると `ERR_HTTP_HEADERS_SENT`）
- `req.query` の値を文字列と決めつけている（`?id=1&id=2` や `?id[]=1` で配列、`?id[a]=1` でオブジェクト）
- ロードバランサの後ろでの `trust proxy` の未設定（`req.ip` が LB の IP になり、IP 単位のレート制限が全員共通）。逆に無条件の `true` では `X-Forwarded-For` を偽装できる（`app.set('trust proxy', 1)` のように LB の段数か CIDR を指定する）

## Sequelize 6

- トランザクションの中のクエリに `{ transaction: t }` を渡し忘れている（CLS を設定していなければ、トランザクションの外で実行される）
- `sequelize.transaction()` を手動で開始し、catch で `rollback()` していない（コールバック形式の managed transaction にする）
- `sequelize.query` や `literal()` にユーザー入力を文字列で埋め込んでいる。`fn()` の関数名にユーザー入力を使っている（`fn()` の引数はエスケープされる。値は `replacements` か `bind` で渡す）
- `Model.update(req.body, ...)` や `Model.create(req.body)` に `fields` の指定が無い（一括代入）
- モデルのインスタンスをそのまま `res.json()` に渡している。パスワードのハッシュなどすべての列が出る（`attributes` で絞るか defaultScope で除外する）
- PostgreSQL の BIGINT と DECIMAL が文字列で返る。`===` での数値比較や `+` による加算が壊れる
- 本番で実行されうる経路に `sync({ alter: true })` や `sync({ force: true })` がある
