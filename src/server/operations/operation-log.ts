// 操作ごとのログ。Workers Logs に JSON の1行で出す（docs/development.md の「API のエラーとログ」）。
// 出すのは下の項目だけ。本文、Cookie、トークン、例外の message は出さない

export type OperationLog = {
  requestId: string;
  operation: string;
  organizationId: string | null;
  // 組織の中の操作では users の ID。組織の外の操作では null（accountId で見る）
  userId: string | null;
  accountId: string | null;
  // 成功は ok、失敗は応答の code
  code: string;
  status: number;
  durationMs: number;
};

export function logOperation(entry: OperationLog): void {
  const line = JSON.stringify({ level: entry.status >= 500 ? 'error' : 'info', ...entry });
  if (entry.status >= 500) console.error(line);
  else console.log(line);
}
