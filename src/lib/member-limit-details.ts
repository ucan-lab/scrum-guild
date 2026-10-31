// 409 の member_limit_reached の details（workspace-reopen と user-enable は { used, limit, adding } を載せる）から、
// 画面に出す数を取り出す。details は unknown なので、形と値を確かめ、読めないときは undefined を返す
export type MemberLimitDetails = { used: number; limit: number; adding: number };

function countOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function memberLimitDetailsOf(details: unknown): MemberLimitDetails | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const record = details as Record<string, unknown>;
  const used = countOf(record.used);
  const limit = countOf(record.limit);
  const adding = countOf(record.adding);
  if (used === undefined || limit === undefined || adding === undefined) return undefined;
  return { used, limit, adding };
}
