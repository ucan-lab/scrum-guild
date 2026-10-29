// パスワードのそろえ方（Issue #256）。NFC にそろえ、そろえた後のコードポイントの数が12〜128なら返す。
// 合わなければ undefined（照合せずに、違うパスワードと同じ応答にする）
// 入れ物。中身は実装の書き手が書く
/* eslint-disable @typescript-eslint/no-unused-vars -- 入れ物の間だけ。実装で外す */

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export function normalizePassword(_input: string): string | undefined {
  throw new Error('未実装');
}
