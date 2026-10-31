// sg mcp の道具の一覧と呼び出しの本体。node の組み込みと MCP の SDK は import しない（Workers のテストから本物の app の fetch を渡して呼ぶため）。
// SDK との結びは mcp-server.ts。src/ は import しない（道具は API の操作の一覧から作る）
import {
  callOperation,
  catalogFor,
  reportOf,
  usage,
  UNLISTED_OPERATION,
  type CatalogOperation,
  type CliDeps,
  type Connection,
} from './main.ts';

export type McpTool = {
  name: string;
  description: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
  annotations: { readOnlyHint: boolean };
};

export type McpToolResult = { content: { type: 'text'; text: string }[]; isError?: true };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// workspace_id を接続先が補えるので、必須から外す（最上位と、oneOf と anyOf の分岐の required）。補うのは sg call と同じく scope が workspace の操作だけ
function withoutWorkspaceRequired(schema: Record<string, unknown>): Record<string, unknown> {
  const strip = (target: Record<string, unknown>): Record<string, unknown> => {
    if (!Array.isArray(target.required)) return target;
    const { required, ...rest } = target;
    const kept = required.filter((key) => key !== 'workspace_id');
    return kept.length > 0 ? { ...rest, required: kept } : rest;
  };
  const result = strip(schema);
  for (const key of ['oneOf', 'anyOf']) {
    const branches = result[key];
    if (Array.isArray(branches)) {
      result[key] = branches.map((branch) => (isRecord(branch) ? strip(branch) : branch));
    }
  }
  return result;
}

function toolOf(operation: CatalogOperation, connection: Connection): McpTool {
  const schema: Record<string, unknown> = { ...operation.input_schema };
  const inputSchema =
    connection.workspace && operation.scope === 'workspace' ? withoutWorkspaceRequired(schema) : schema;
  return {
    name: operation.name,
    description: typeof operation.description === 'string' ? operation.description : '',
    // MCP の道具の入力は object。最上位が oneOf だけの Schema にも type を付ける
    inputSchema: { ...inputSchema, type: 'object' },
    annotations: { readOnlyHint: operation.mode === 'read' },
  };
}

// tools/list のたびに操作の一覧を取る（キャッシュしない）。取れないときは ApiCliError か CliError を投げる
export async function listTools(deps: CliDeps, connection: Connection): Promise<McpTool[]> {
  return (await catalogFor(deps, connection)).map((operation) => toolOf(operation, connection));
}

// 失敗は isError の結果にして返す（投げない）。API のエラーは {"status", "error"} の JSON、そのほかは {"error": {"code", "message"}}。
// 一覧に無い操作（無い操作と、このトークンでは呼べない操作）は、呼ぶ前に断る
export async function callTool(
  deps: CliDeps,
  connection: Connection,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<McpToolResult> {
  try {
    const operation = (await catalogFor(deps, connection)).find((item) => item.name === name);
    if (!operation) throw usage(UNLISTED_OPERATION);
    const body = await callOperation(deps, connection, operation, { ...args });
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: reportOf(error).text }] };
  }
}
