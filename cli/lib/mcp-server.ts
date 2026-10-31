// sg mcp: MCP の SDK の低水準 Server で tools/list と tools/call を結ぶ。道具の一覧と呼び出しの本体は mcp-tools.ts。
// 標準出力は MCP のプロトコル専用。ここからも本体からも、標準出力へ書かない。src/ は import しない
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { connectionFromArgs, reportOf, type CliDeps, type Connection } from './main.ts';
import { callTool, listTools, type McpOptions } from './mcp-tools.ts';

// idle は、処理中のリクエストが無くなるまで待つ（標準入力が閉じても、送られた分の応答は返してから閉じる）
export function createMcpServer(
  deps: CliDeps,
  connection: Connection,
  options: McpOptions,
): { server: Server; idle(): Promise<void> } {
  // version は固定。CLI は npm に出さずリポジトリから動かすので、配る版が無い（package.json にも version が無い）。MCP の initialize に版が要るので置いている
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
      listTools(deps, connection, options).then(
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
    return track(callTool(deps, connection, name, args, options));
  });
  const idle = async () => {
    // SDK はハンドラーを Promise.resolve().then で呼ぶので、受け取った直後は pending がまだ空。1周待ってから数える
    await new Promise((resolve) => setImmediate(resolve));
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
  let allowWrite: boolean;
  try {
    ({ connection, allowWrite } = await connectionFromArgs(args, deps));
  } catch (error) {
    const report = reportOf(error);
    deps.stderr(report.text + '\n');
    return report.exitCode;
  }
  const { server, idle } = createMcpServer(deps, connection, { allowWrite });
  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  if (transport === undefined) {
    process.stdin.once('end', () => void idle().then(() => server.close()));
    // クライアントが先に消えて読み手の無い標準出力に書くと EPIPE になる。スタックトレースを出さず静かに閉じる
    process.stdout.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') throw error;
      void server.close();
    });
    transport = new StdioServerTransport();
  }
  await server.connect(transport);
  await closed;
  return 0;
}
