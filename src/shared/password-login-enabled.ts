// メールアドレスとパスワードでのログイン（手段 `password`）を開いているか。初版は閉じている（Issue #635）。
// API の口（POST /api/auth/password/login、src/server/app.ts）、ログインの画面のフォーム、e2e の飛ばし方がこの値を読む。
// 開くときは、登録の入口（#257、#258）と一緒に true にする（docs/development.md の「パスワードのログイン」）。
// 型を boolean にして、この値で分ける条件を lint の「定数の条件」にしない
export const PASSWORD_LOGIN_ENABLED: boolean = false;
