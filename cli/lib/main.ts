// sg コマンドの本体。終了コードを返す。node の組み込みは import しない（Workers のテストから本物の app の fetch を渡して呼ぶため）。
// src/ は import しない（操作の一覧は API から取る）
export type Profile = { url?: string; token?: string; org?: string; workspace?: string };

export type Config = { default_profile?: string; profiles: Record<string, Profile> };

export type ConfigStore = {
  read(): Promise<Config | undefined>;
  write(config: Config): Promise<void>;
};

export type CliDeps = {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
  config: ConfigStore;
};

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  try {
    const command = argv[0];
    if (command === 'config') return await configCommand(argv.slice(1), deps);
    if (command === 'ops') return await opsCommand(argv.slice(1), deps);
    if (command === 'call') return await callCommand(argv.slice(1), deps);
    throw usage('コマンドは ops、call、config のいずれか');
  } catch (error) {
    if (error instanceof ApiCliError) {
      deps.stderr(error.output + '\n');
      return 1;
    }
    if (error instanceof CliError) {
      deps.stderr(JSON.stringify({ error: { code: error.code, message: error.message } }) + '\n');
      return error.code === 'usage' ? 2 : 3;
    }
    deps.stderr(JSON.stringify({ error: { code: 'connection_failed', message: messageOf(error) } }) + '\n');
    return 3;
  }
}

type CatalogOperation = {
  name: string;
  description: string;
  mode: 'read' | 'write';
  scope: 'outside' | 'organization' | 'workspace';
  input_schema: JsonSchema;
  output_schema: JsonSchema;
};
type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  const?: unknown;
  enum?: unknown[];
};

class CliError extends Error {
  readonly code: 'usage' | 'connection_failed';
  constructor(code: 'usage' | 'connection_failed', message: string) {
    super(message);
    this.code = code;
  }
}
class ApiCliError extends Error {
  readonly output: string;
  constructor(output: string) {
    super(output);
    this.output = output;
  }
}
const usage = (message: string) => new CliError('usage', message);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

// 設定ファイルが読めない（壊れた JSON など）のはサーバーへ送る前の誤り。元の message には設定の中身（トークン）が入りうるので使わない
async function readConfig(deps: CliDeps): Promise<Config | undefined> {
  let config: unknown;
  try {
    config = await deps.config.read();
  } catch {
    throw usage('設定ファイルを読めない');
  }
  if (config === undefined) return undefined;
  if (!isConfig(config)) throw usage('設定ファイルの形が不正');
  return config;
}

// 設定を書けないのもサーバーへ送る前の誤り。元の message には設定のパスや中身が入りうるので使わない
async function writeConfig(deps: CliDeps, config: Config): Promise<void> {
  try {
    await deps.config.write(config);
  } catch {
    throw usage('設定ファイルを書けない');
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// { default_profile?, profiles: { <名前>: { url?, token?, org?, workspace? } } } の形か。項目は文字列に限る
function isConfig(value: unknown): value is Config {
  if (!isRecord(value) || !isRecord(value.profiles)) return false;
  if (value.default_profile !== undefined && typeof value.default_profile !== 'string') return false;
  return Object.values(value.profiles).every(
    (profile) =>
      isRecord(profile) &&
      ['url', 'token', 'org', 'workspace'].every(
        (key) => profile[key] === undefined || typeof profile[key] === 'string',
      ),
  );
}

async function configCommand(args: string[], deps: CliDeps): Promise<number> {
  const { options, positional } = optionsOf(args);
  const config = (await readConfig(deps)) ?? { profiles: {} };
  const profileName = options.profile ?? deps.env.SG_PROFILE ?? config.default_profile ?? 'main';
  if (positional[0] === 'set') {
    const key = positional[1] as 'url' | 'org' | 'workspace' | 'token' | undefined;
    if (!key || !['url', 'org', 'workspace', 'token'].includes(key)) throw usage('config set の項目が不正');
    if (key === 'token') {
      if (positional.length !== 2 || options.extra.length > 0) throw usage('token は標準入力から指定する');
    } else {
      if (positional.length !== 3 || positional[2] === undefined) throw usage('config set の値が無い');
    }
    const next = structuredClone(config);
    next.profiles[profileName] ??= {};
    const value = key === 'token' ? (await deps.readStdin()).replace(/(?:\r\n|\n|\r)+$/, '') : positional[2]!;
    next.profiles[profileName]![key] = value;
    await writeConfig(deps, next);
    return 0;
  }
  if (positional[0] === 'use') {
    if (positional.length !== 2 || !config.profiles[positional[1]!]) throw usage('存在する接続先を指定する');
    config.default_profile = positional[1];
    await writeConfig(deps, config);
    return 0;
  }
  if (positional[0] === 'show' && positional.length === 1) {
    const shown = structuredClone(config);
    for (const profile of Object.values(shown.profiles)) if (profile.token !== undefined) profile.token = '********';
    deps.stdout(JSON.stringify(shown, null, 2) + '\n');
    return 0;
  }
  throw usage('config の使い方が不正');
}

function optionsOf(args: string[]): {
  positional: string[];
  options: { profile?: string; org?: string; workspace?: string; extra: string[] };
} {
  const positional: string[] = [];
  const options: { profile?: string; org?: string; workspace?: string; extra: string[] } = { extra: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw usage(`--${key} の値が無い`);
    if (key === 'profile' || key === 'org' || key === 'workspace') options[key] = value;
    else options.extra.push(key, value);
  }
  return { positional, options };
}

async function catalogFor(deps: CliDeps, connection: Connection): Promise<CatalogOperation[]> {
  const response = await request(deps, connection, '/api/operation-list', {});
  if (!response.ok) throw await apiError(response);
  const body = (await response.json()) as { operations?: CatalogOperation[] };
  if (!Array.isArray(body.operations)) throw new CliError('connection_failed', '操作一覧の応答が不正');
  return body.operations;
}

async function opsCommand(args: string[], deps: CliDeps): Promise<number> {
  const { positional, options } = optionsOf(args);
  if (positional.length > 1) throw usage('ops の操作名が多い');
  const connection = await connectionOf(options, deps);
  const catalog = await catalogFor(deps, connection);
  const operation = positional[0] === undefined ? undefined : catalog.find((item) => item.name === positional[0]);
  if (positional[0] !== undefined && operation === undefined) throw usage('操作が一覧に無い');
  deps.stdout(JSON.stringify(operation ?? { operations: catalog }, null, 2) + '\n');
  return 0;
}

const HEADER_SAFE_TOKEN = /^[\x21-\x7e]+$/;

type Connection = { url: string; token: string; org?: string; workspace?: string };
async function connectionOf(
  options: { profile?: string; org?: string; workspace?: string },
  deps: CliDeps,
): Promise<Connection> {
  const config = (await readConfig(deps)) ?? { profiles: {} };
  const name = options.profile ?? deps.env.SG_PROFILE ?? config.default_profile ?? 'main';
  const profile = config.profiles[name];
  if (options.profile !== undefined && profile === undefined) throw usage('接続先が無い');
  const url = deps.env.SG_URL ?? profile?.url;
  const token = deps.env.SG_TOKEN ?? profile?.token;
  if (!url || !token) throw usage('url と token の設定が必要');
  // 空白や改行を含む値は Authorization ヘッダーに置けず、fetch の誤りの message に値が入る。送る前に止める（値は出さない）
  if (!HEADER_SAFE_TOKEN.test(token)) throw usage('token に使えない文字がある（空白、改行、ASCII 以外）');
  return {
    url: url.replace(/\/+$/, ''),
    token,
    org: options.org ?? deps.env.SG_ORG ?? profile?.org,
    workspace: options.workspace ?? deps.env.SG_WORKSPACE ?? profile?.workspace,
  };
}

async function callCommand(args: string[], deps: CliDeps): Promise<number> {
  const { positional, options } = optionsOf(args);
  const name = positional.shift();
  if (!name || positional.length > 1) throw usage('call の操作名または JSON が不正');
  const connection = await connectionOf(options, deps);
  const catalog = await catalogFor(deps, connection);
  const operation = catalog.find((item) => item.name === name);
  if (!operation) throw usage('操作が一覧に無い');
  let input: Record<string, unknown> = {};
  if (positional[0] !== undefined) {
    try {
      const parsed: unknown = JSON.parse(positional[0]);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object');
      input = parsed as Record<string, unknown>;
    } catch {
      throw usage('JSON が不正');
    }
  }
  for (let i = 0; i < options.extra.length; i += 2) {
    const key = options.extra[i]!;
    const value = options.extra[i + 1]!;
    input[key] = valueOf(value, propertySchema(operation.input_schema, key));
  }
  if (operation.scope !== 'outside' && !connection.org) throw usage('org が必要');
  if (operation.scope === 'workspace' && input.workspace_id === undefined) {
    if (!connection.workspace) throw usage('workspace が必要');
    input.workspace_id = connection.workspace;
  }
  const path = operation.scope === 'outside' ? `/api/${name}` : `/api/${encodeURIComponent(connection.org!)}/${name}`;
  const response = await request(deps, connection, path, input);
  if (!response.ok) throw await apiError(response);
  deps.stdout(JSON.stringify(await response.json(), null, 2) + '\n');
  return 0;
}

// 最上位が oneOf/anyOf（discriminatedUnion）の入力は、分岐のどれかに項目があれば受け付け、分岐ごとの Schema を anyOf にまとめる
function propertySchema(input: JsonSchema, key: string): JsonSchema | undefined {
  const found = [input, ...(input.oneOf ?? []), ...(input.anyOf ?? [])]
    .map((schema) => schema.properties?.[key])
    .filter((schema): schema is JsonSchema => schema !== undefined);
  if (found.length === 0) return undefined;
  return found.length === 1 ? found[0] : { anyOf: found };
}

// type、const、enum、anyOf、oneOf を辿り、取りうる値の型を集める。数の const だけの分岐は number になる
function typesOf(schema: JsonSchema): Set<string> {
  const types = new Set<string>();
  for (const type of Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []) types.add(type);
  const literals = 'const' in schema ? [schema.const] : (schema.enum ?? []);
  for (const literal of literals)
    types.add(literal === null ? 'null' : Array.isArray(literal) ? 'array' : typeof literal);
  for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])])
    for (const type of typesOf(branch)) types.add(type);
  return types;
}

function valueOf(raw: string, schema: JsonSchema | undefined): unknown {
  if (!schema) throw usage('入力に無い項目');
  const types = [...typesOf(schema)];
  if (types.includes('object') || types.includes('array')) throw usage('object と array は引数にできない');
  if (raw === 'null' && types.includes('null')) return null;
  // string 以外の型に変えられる値はその型にし、変えられず string を許すなら文字列のまま送る。どれにも合わなければ使い方の誤り
  if (types.includes('boolean')) {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  }
  // Number('') と Number(' ') は 0 になるので、空白だけの値は数にしない
  const value = Number(raw);
  if (raw.trim() !== '') {
    if (types.includes('number') && Number.isFinite(value)) return value;
    if (types.includes('integer') && Number.isInteger(value)) return value;
  }
  if (types.includes('string')) return raw;
  const wanted = ['boolean', 'integer', 'number'].find((type) => types.includes(type));
  if (wanted) throw usage(`${wanted} の値が不正`);
  throw usage('引数の型を変えられない');
}

async function request(deps: CliDeps, connection: Connection, path: string, body: unknown): Promise<Response> {
  try {
    return await deps.fetch(`${connection.url}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    // fetch の誤りの message にヘッダーの値が入ることがあるので、トークンは伏せる
    throw new CliError('connection_failed', messageOf(error).split(connection.token).join('********'));
  }
}

async function apiError(response: Response): Promise<ApiCliError> {
  let error: unknown;
  try {
    error = ((await response.json()) as { error?: unknown }).error;
  } catch {
    error = undefined;
  }
  return new ApiCliError(JSON.stringify({ status: response.status, error }));
}
