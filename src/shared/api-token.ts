// API トークン（docs/data-model.md の `api_tokens`）の形と上限。Authorization: Bearer に載せる
export const API_TOKEN_PATTERN = /^sgp_[A-Za-z0-9_-]{43}$/;

// 発行から失効までの上限の日数。使っても延ばさない
export const API_TOKEN_MAX_LIFETIME_DAYS = 90;

// 1アカウントが持てる有効な（取り消していない、期限前の）トークンの数。超える発行は 409 の conflict（details.reason は API_TOKEN_LIMIT_REASON）
export const API_TOKEN_MAX_ACTIVE = 20;
export const API_TOKEN_LIMIT_REASON = 'limit';

// API トークンの発行は、ログイン（sessions.created_at）からこの分数以内のセッションに限る。ちょうどこの分数は通す
export const API_TOKEN_REAUTH_MINUTES = 10;

// read は mode が read の操作だけ、write は read と write の操作を呼べる
export type ApiTokenScope = 'read' | 'write';
