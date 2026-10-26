// 409 の conflict で断った理由を、応答の details.reason から取り出す。操作ごとに理由の一覧を持ち（移動は task-move.ts、
// ストーリーの完了と取り消しは story-complete.ts）、画面はこれで知らせる文を選ぶ。形が違うか、一覧に無ければ undefined
export function conflictReasonOf<const Reasons extends readonly string[]>(
  details: unknown,
  reasons: Reasons,
): Reasons[number] | undefined {
  if (typeof details !== 'object' || details === null || !('reason' in details)) return undefined;
  const { reason } = details;
  return (reasons as readonly unknown[]).includes(reason) ? (reason as Reasons[number]) : undefined;
}
