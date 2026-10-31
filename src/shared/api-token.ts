// API トークン（docs/data-model.md の `api_tokens`）の形と上限。Authorization: Bearer に載せる
export const API_TOKEN_PATTERN = /^sgp_[A-Za-z0-9_-]{43}$/;

// 発行から失効までの上限の日数。使っても延ばさない
export const API_TOKEN_MAX_LIFETIME_DAYS = 90;

// read は mode が read の操作だけ、write は read と write の操作を呼べる
export type ApiTokenScope = 'read' | 'write';
