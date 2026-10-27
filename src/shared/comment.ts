// タスクのコメントの本文の決まり。書く操作と直す操作、引き出しのコメントの欄が同じ判定を使う。
// 画面の束にも入るので、Worker のコードを引かない。整え方はタスクの本文と同じ（story.ts の normalizeLongText と longTextProblem）
import { z } from 'zod';
import './zod-config.ts';
import { longTextProblem, normalizeLongText } from './story.ts';

// 本文は 10 万字まで（コードポイント）。comments.body_md の CHECK（length(body_md) <= 100000）と同じ
export const COMMENT_BODY_MAX_LENGTH = 100_000;

export type CommentBodyProblem = 'required' | 'too_long' | 'invalid_character';

// 送る前の本文の判定。改行をそろえ、前後の空行と末尾の空白を落とした後に、空（空白だけを含む）なら required
export function commentBodyProblem(raw: string): CommentBodyProblem | null {
  const value = normalizeLongText(raw);
  if (value === null) return 'required';
  return longTextProblem(value, COMMENT_BODY_MAX_LENGTH);
}

// 整えた本文。空は入力の誤り（400）
export const commentBodySchema = z.string().transform((raw, ctx) => {
  const problem = commentBodyProblem(raw);
  if (problem !== null) {
    ctx.addIssue({ code: 'custom', message: `コメントの本文が使えない（${problem}）` });
    return z.NEVER;
  }
  return normalizeLongText(raw) ?? '';
});
