// 運用者の判定（docs/development.md の「Google のログイン」の運用者のログインの ID）。
// 一覧はシークレット OPERATOR_LOGIN_IDS に、github:<数字> か google:<数字> をカンマで区切って持つ。
// 比べるのは手段と ID の文字列の完全一致だけ。人が差分を読む領域（docs/development.md の「マージの判定」）
import type { LoginId } from '../db/index.ts';

const OPERATOR_LOGIN_ID_PATTERN = /^(github|google):[0-9]+$/;

export type OperatorLoginIds =
  | { ok: true; ids: ReadonlySet<string> }
  // 形の合わない項目の位置（1 から数える）。値は持たない。ログに出す値は位置だけにするため
  | { ok: false; invalidPositions: readonly number[] };

// 未設定は運用者がいない状態。設定されているのに形が合わないときだけ失敗にする
export function parseOperatorLoginIds(raw: unknown): OperatorLoginIds {
  if (raw === undefined) return { ok: true, ids: new Set() };
  if (typeof raw !== 'string') return { ok: false, invalidPositions: [] };
  const items = raw.split(',');
  const invalidPositions = items.flatMap((item, index) => (OPERATOR_LOGIN_ID_PATTERN.test(item) ? [] : [index + 1]));
  return invalidPositions.length > 0 ? { ok: false, invalidPositions } : { ok: true, ids: new Set(items) };
}

// 解釈は設定の値が変わるまで1回。Worker の中で起動のときに解釈するのと同じにする
let cache: { raw: unknown; parsed: OperatorLoginIds } | undefined;

// シークレットは wrangler types が .dev.vars のあるときだけ型に出す。型に頼らず、値の有無を見る
export function operatorLoginIds(env: object): OperatorLoginIds {
  const raw = 'OPERATOR_LOGIN_IDS' in env ? env.OPERATOR_LOGIN_IDS : undefined;
  if (cache === undefined || cache.raw !== raw) cache = { raw, parsed: parseOperatorLoginIds(raw) };
  return cache.parsed;
}

export function isOperator(operators: ReadonlySet<string>, logins: readonly LoginId[]): boolean {
  return logins.some((login) => operators.has(`${login.provider}:${login.subject}`));
}

// 運用者の一覧に載っているログインの ID（`github:12345` の形）。複数のログインを結んだ人が、一覧のログインを2つ以上持つときは、
// 一覧の並びで先のものを使う（ログインを引く順に結果が左右されない）。載っていなければ undefined。
// 運用者の操作の記録（organizations.created_by_operator、change_logs.operator）に残す値
export function operatorLoginIdOf(env: object, logins: readonly LoginId[]): string | undefined {
  const operators = operatorLoginIds(env);
  if (!operators.ok) return undefined;
  const owned = new Set(logins.map((login) => `${login.provider}:${login.subject}`));
  return [...operators.ids].find((id) => owned.has(id));
}

// シークレットの運用者の一覧に、これらのログインのどれかが載っているか。運用者の判定の式はここに1つだけ置く
// （登録の関数が account.isOperator() で、ログインの分かれ道が login.ts で呼ぶ）。
// 設定の誤りは app のミドルウェアが先に 500 にしているので、ここに来る一覧は解釈できている。未設定は運用者がいない
export function isOperatorLogin(env: object, logins: readonly LoginId[]): boolean {
  const operators = operatorLoginIds(env);
  return operators.ok && isOperator(operators.ids, logins);
}
