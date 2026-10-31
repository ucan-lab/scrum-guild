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

type Branch = { properties: Record<string, unknown>; required: string[] };

const branchOf = (schema: unknown): Branch | undefined =>
  isRecord(schema)
    ? {
        properties: isRecord(schema.properties) ? schema.properties : {},
        required: Array.isArray(schema.required) ? schema.required.filter((key) => typeof key === 'string') : [],
      }
    : undefined;

// 同名の項目の Schema を集める。同じならそのまま、分かれるなら anyOf でまとめる
function mergedProperties(branches: Branch[]): Record<string, unknown> {
  const collected = new Map<string, unknown[]>();
  for (const branch of branches) {
    for (const [key, schema] of Object.entries(branch.properties)) {
      const list = collected.get(key) ?? [];
      if (!list.some((item) => JSON.stringify(item) === JSON.stringify(schema))) list.push(schema);
      collected.set(key, list);
    }
  }
  return Object.fromEntries([...collected].map(([key, list]) => [key, list.length === 1 ? list[0] : { anyOf: list }]));
}

// 分岐の見出し。const を持つ項目（discriminatedUnion の判別の項目）で呼ぶ
function labelOf(branch: Branch, index: number): string {
  const labels = Object.entries(branch.properties)
    .filter(([, schema]) => isRecord(schema) && 'const' in schema)
    .map(([key, schema]) => `${key}=${String((schema as { const: unknown }).const)}`);
  return labels.length > 0 ? labels.join(',') : `分岐${index + 1}`;
}

// Claude API は input_schema の最上位の oneOf、anyOf、allOf を受け付けないので、各分岐の properties の和集合の1つの object に平らにする。
// required は全分岐に共通のものだけ。分岐ごとの必須は説明の末尾に足す
function flatten(
  input: Record<string, unknown>,
  stripWorkspace: boolean,
): { schema: Record<string, unknown>; note: string } {
  const { oneOf, anyOf, allOf, ...base } = input;
  delete base.$schema;
  const own = branchOf(base)!;
  const parts = (Array.isArray(allOf) ? allOf : []).map(branchOf).filter((part) => part !== undefined);
  const alternatives = [oneOf, anyOf]
    .flatMap((group) => (Array.isArray(group) ? [group.map(branchOf).filter((part) => part !== undefined)] : []))
    .filter((group) => group.length > 0);
  const without = (required: string[]) =>
    stripWorkspace ? required.filter((key) => key !== 'workspace_id') : required;
  // allOf は全部が成り立つので、基本の項目に重ねる。必須は和集合
  const all = [own, ...parts];
  let properties = mergedProperties(all);
  let required = without([...new Set(all.flatMap((part) => part.required))]);
  const notes: string[] = [];
  for (const group of alternatives) {
    const merged = mergedProperties([{ properties, required: [] }, ...group]);
    const common = group.map((branch) => without(branch.required)).reduce((x, y) => x.filter((key) => y.includes(key)));
    properties = merged;
    required = [...new Set([...required, ...common])];
    notes.push(
      ...group.map(
        (branch, index) => `${labelOf(branch, index)} の必須: ${without(branch.required).join(', ') || 'なし'}`,
      ),
    );
  }
  const schema: Record<string, unknown> = { ...base, type: 'object', properties };
  delete schema.required;
  if (required.length > 0) schema.required = required;
  return { schema, note: notes.length > 0 ? `分岐: ${notes.join(' / ')}` : '' };
}

function toolOf(operation: CatalogOperation, connection: Connection): McpTool {
  const { schema, note } = flatten(
    { ...operation.input_schema },
    // workspace_id は接続先が補えるので、必須から外す。補うのは sg call と同じく scope が workspace の操作だけ
    Boolean(connection.workspace) && operation.scope === 'workspace',
  );
  const description = typeof operation.description === 'string' ? operation.description : '';
  return {
    name: operation.name,
    description: note === '' ? description : `${description}\n${note}`,
    inputSchema: { ...schema, type: 'object' },
    annotations: { readOnlyHint: operation.mode === 'read' },
  };
}

// sg mcp の --allow-write。既定（false）では、読み取り（mode: 'read'）の操作だけを道具にする。
// 付けても、読み取りのトークンでは書き込みの操作が一覧に来ない（サーバーがトークンで絞る）ので、書き込みの道具は出ない
export type McpOptions = { allowWrite?: boolean };
const visible = (operation: CatalogOperation, options: McpOptions) =>
  options.allowWrite === true || operation.mode === 'read';

// tools/list のたびに操作の一覧を取る（キャッシュしない）。取れないときは ApiCliError か CliError を投げる
export async function listTools(deps: CliDeps, connection: Connection, options: McpOptions = {}): Promise<McpTool[]> {
  return (await catalogFor(deps, connection))
    .filter((operation) => visible(operation, options))
    .map((operation) => toolOf(operation, connection));
}

// 失敗は isError の結果にして返す（投げない）。API のエラーは {"status", "error"} の JSON、そのほかは {"error": {"code", "message"}}。
// 一覧に無い操作（無い操作と、このトークンでは呼べない操作）は、呼ぶ前に断る
export async function callTool(
  deps: CliDeps,
  connection: Connection,
  name: string,
  args: Record<string, unknown> | undefined,
  options: McpOptions = {},
): Promise<McpToolResult> {
  try {
    // 一覧に出さない操作（既定の書き込み）は、無い操作と同じ使い方の誤りで断る
    const operation = (await catalogFor(deps, connection))
      .filter((item) => visible(item, options))
      .find((item) => item.name === name);
    if (!operation) throw usage(UNLISTED_OPERATION);
    const input = { ...args };
    // 接続先がワークスペースを持つとき、null と空文字の workspace_id は省いたものとして補う（AI が空欄を埋めて渡すため。sg call は変えない）
    if (
      connection.workspace &&
      operation.scope === 'workspace' &&
      (input.workspace_id === null || input.workspace_id === '')
    )
      delete input.workspace_id;
    const body = await callOperation(deps, connection, operation, input);
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: reportOf(error).text }] };
  }
}
