// sg mcp: MCP の SDK の低水準 Server で tools/list と tools/call を結ぶ。道具の一覧と呼び出しの本体は mcp-tools.ts。
// 標準出力は MCP のプロトコル専用。ここからも本体からも、標準出力へ書かない。src/ は import しない
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { connectionFromArgs, reportOf, type CliDeps, type Connection } from './main.ts';
import { callTool, listTools } from './mcp-tools.ts';

// idle は、処理中のリクエストが無くなるまで待つ（標準入力が閉じても、送られた分の応答は返してから閉じる）
export function createMcpServer(deps: CliDeps, connection: Connection): { server: Server; idle(): Promise<void> } {
  const server = new Server({ name: 'scrum-guild', version: '0.1.0' }, { capabilities: { tools: {} } });
  const pending = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  };
  server.setRequestHandler(ListToolsRequestSchema, () =>
    track(
      listTools(deps, connection).then(
        (tools) => ({ tools }),
        (error: unknown) => {
          // 一覧が取れないのはプロトコルの誤り。message はトークンを含まない（reportOf が伏せる）
          throw new McpError(ErrorCode.InternalError, reportOf(error).text);
        },
      ),
    ),
  );
  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { name, arguments: args } = request.params;
    return track(callTool(deps, connection, name, args));
  });
  const idle = async () => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
    // 応答を書く処理が済むまで 1 周待つ
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { server, idle };
}

// 接続先の誤りは標準エラーに JSON で出して 2。標準入力が閉じる（transport が閉じる）まで動く。
// transport を渡さないときは標準入出力で動き、標準入力の終わりで閉じる
export async function runMcp(args: string[], deps: CliDeps, transport?: Transport): Promise<number> {
  let connection: Connection;
  try {
    connection = await connectionFromArgs(args, deps);
  } catch (error) {
    const report = reportOf(error);
    deps.stderr(report.text + '\n');
    return report.exitCode;
  }
  const { server, idle } = createMcpServer(deps, connection);
  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  if (transport === undefined) {
    process.stdin.once('end', () => void idle().then(() => server.close()));
    transport = new StdioServerTransport();
  }
  await server.connect(transport);
  await closed;
  return 0;
}
