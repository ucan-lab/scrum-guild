import { z } from 'zod';

// エピックとストーリーを削除するときの、配下の扱い（docs/requirements.md の「削除」）。
// keep: 直接の子を親なしで残す（エピックなら配下のストーリー、ストーリーなら配下のタスク）。子は移す先の末尾に、元の並びのまま置く。
// delete: 木の下をまとめて削除する。手で作ったタスクは論理削除、取り込んだタスクは削除せずアーカイブへ移す
export const deleteChildrenModes = ['keep', 'delete'] as const;
export const deleteChildrenSchema = z.enum(deleteChildrenModes);
export type DeleteChildrenMode = z.output<typeof deleteChildrenSchema>;

// リーダーと管理者でない人が delete で消すときは、削除していない配下（手で作ったもの）がすべて本人の作ったものでなければならない。
// 他の人の作った配下があれば 403 の forbidden で断り、理由をこの値で details.reason に載せる
export const DELETE_OTHERS_CHILDREN_REASON = 'others_children';
