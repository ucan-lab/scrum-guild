対象の拡張子: .ts .tsx .mts .cts .js .jsx .mjs .cjs .svelte

# TypeScript / JavaScript

## 一般

- 処理されない Promise の reject、空の `catch`
- `array.forEach(async fn)` は完了を待たない（`for...of` か `Promise.all` にする）
- try の中で await せずに `return promise` していて、reject が catch に入らない
- デバッグ用の `console.log` が残っている
- 外部への HTTP 呼び出しにタイムアウトが無い
- コンポーネントの CSS で `prefers-reduced-motion` のときに `animation: none` にする要素に、キーフレームで変えていた `opacity` や `transform` の静止時の値が通常のルールに無い（止めると初期値の `opacity: 1` などに戻り、フェードで見え隠れさせていた光や重ねた要素が最大の強さで出たままになる）

## セキュリティ

- `innerHTML` や Svelte の `{@html}` にユーザー由来の値を入れている（`textContent` にするか DOMPurify を通す）
- リクエストの body や params をスキーマで検証せずに使っている
- `fetch(userProvidedUrl)` のように、ユーザーが指定した URL へサーバーからリクエストしている（SSRF）
- `child_process.exec` にユーザー入力を渡している（`execFile` か `spawn` を shell 無しで使い、ユーザー入力の引数の前に `--` を置く）
- 内部エラーの詳細をそのままクライアントに返している
- `{"__proto__": ...}` を含む入力を再帰的な merge に通している（グローバルの prototype が汚染される。`Object.assign` でも対象オブジェクトの prototype は差し替わる。`__proto__`、`constructor`、`prototype` のキーを弾くか、スキーマで検証する）

## DB

- ループの中でクエリを発行している（N+1）
- 利用者向けのエンドポイントに `LIMIT` の無いクエリがある

## Svelte 5

- `$state` のオブジェクトを分割代入してリアクティビティを失っている（失うのはプリミティブの値だけで、ネストしたオブジェクトは proxy のまま）
- 他の state から計算できる値を `$effect` の中で代入している（`$derived` を使う。`$effect` の中で読んだ state に書き込むと無限ループになる）
- `$effect` の中で `await` や `setTimeout` のあとに読んだ値（依存として追跡されず、変わっても再実行されない）
- 通常の `.ts` ファイルで runes を使っている（`.svelte.ts` か `.svelte.js` でないと動かない）
- `{@html}` にユーザー由来の値を出している

## SvelteKit 2（SPA モード）

- `+page.server.ts`、`+layout.server.ts`、`+server.ts`、`hooks.server.ts`、form actions を書いている（SPA モードでは使わない。データは Hono の API から取る）
- ルートで `ssr` や `prerender` の設定を上書きしている（SSR を切った SPA の前提が崩れる）
- 画面に入れる環境変数に秘密の値を入れている（SPA では、画面が読む値はすべて配信される。秘密は Worker のシークレットに置く）
- 権限の確認を画面のレイアウトだけでしている（画面の確認は表示を切り替えるためで、権限は API が検査する）
- `redirect()` と `error()` は例外を投げるので、囲んだ `try/catch` に握りつぶされる（`isRedirect` と `isHttpError` で投げ直す）
- load の中でグローバルの `fetch` を使っている（引数で渡される `fetch` を使う）
- URL の値（`?next=` など）をそのまま `goto()` や遷移先に使っている（同じオリジンの相対パスか確かめる）
- 版のずれの検知（`version.pollInterval` と `updated`）を使わず、画面の再読み込みを促す作りを別に持っている
