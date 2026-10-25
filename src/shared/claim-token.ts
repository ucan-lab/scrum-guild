// 招待の URL の秘密（docs/data-model.md の「メールアドレスで待つ指名と招待」）。
// 32 バイトの乱数を base64url にした43文字を、URL のフラグメント（`/invite#<秘密>`）にだけ入れる。
// 画面（/invite）とログインの開始（POST /api/auth/google/start）が同じ形の検査を使う

export const CLAIM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// ログインを始めるフォームの欄の名前（application/x-www-form-urlencoded の本文）
export const CLAIM_TOKEN_FIELD = 'claim_token';

export const INVITE_PATH = '/invite';

// 招待の URL の期限（作ってから14日）
export const CLAIM_LIFETIME_DAYS = 14;

// 待つ間の users.name はメールアドレスなので、change_logs には代わりにこの名前を残す（指名したときと結んだときで同じ）
export const WAITING_USER_NAME_IN_LOG = 'Google の招待（ログイン待ち）';
