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

// 終了コード: API のエラーと応答の誤りは 1、使い方の誤りは 2、fetch が投げたときは 3
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  try {
    const command = argv[0];
    if (command === 'config') return await configCommand(argv.slice(1), deps);
    if (command === 'ops') return await opsCommand(argv.slice(1), deps);
    if (command === 'call') return await callCommand(argv.slice(1), deps);
    throw usage('コマンドは ops、call、config、mcp のいずれか');
  } catch (error) {
    const report = reportOf(error);
    deps.stderr(report.text + '\n');
    return report.exitCode;
  }
}

// 失敗の出力（標準エラーの JSON、MCP の isError の text）と終了コード。sg mcp も同じ形を使う
export function reportOf(error: unknown): { text: string; exitCode: number } {
  if (error instanceof ApiCliError) return { text: error.output, exitCode: 1 };
  if (error instanceof CliError) {
    return {
      text: JSON.stringify({ error: { code: error.code, message: error.message } }),
      exitCode: error.code === 'usage' ? 2 : error.code === 'connection_failed' ? 3 : 1,
    };
  }
  // 想定外の失敗。元の message には設定やヘッダーの値が入りうるので出さない
  return { text: JSON.stringify({ error: { code: 'internal_error', message: '想定外の失敗' } }), exitCode: 1 };
}

export type CatalogOperation = {
  name: string;
  description: string;
  mode: 'read' | 'write';
  scope: 'outside' | 'organization' | 'workspace';
  input_schema: JsonSchema;
  output_schema: JsonSchema;
};
export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  const?: unknown;
  enum?: unknown[];
};

export type CliErrorCode = 'usage' | 'connection_failed' | 'invalid_response';
export class CliError extends Error {
  readonly code: CliErrorCode;
  constructor(code: CliErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
export class ApiCliError extends Error {
  readonly output: string;
  constructor(output: string) {
    super(output);
    this.output = output;
  }
}
export const usage = (message: string) => new CliError('usage', message);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const REQUEST_TIMEOUT_MS = 30_000;
export const UNLISTED_OPERATION = '操作が一覧に無い（無い操作か、このトークンでは呼べない操作）';
const URL_MESSAGE = 'url が不正（http か https、認証情報なし。http は localhost のみ）';
// 接続先の名前にできない。オブジェクトの組み込みの項目を引かないため
const FORBIDDEN_PROFILE_NAMES = ['__proto__', 'constructor', 'prototype'];
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const HEADER_SAFE_TOKEN = /^[\x21-\x7e]+$/;
// 0x10、0b11、Infinity、先頭の + や末尾の . を数にしない
const NUMBER_PATTERN = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

// 空の環境変数は未設定として扱う
const envOf = (deps: CliDeps, key: string): string | undefined => deps.env[key] || undefined;

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

// { default_profile?, profiles: { <名前>: { url?, token?, org?, workspace? } } } の形か。項目は文字列に限り、名前に組み込みの項目の名前は使えない
function isConfig(value: unknown): value is Config {
  if (!isRecord(value) || !isRecord(value.profiles)) return false;
  if (value.default_profile !== undefined && typeof value.default_profile !== 'string') return false;
  if (Object.keys(value.profiles).some((name) => FORBIDDEN_PROFILE_NAMES.includes(name))) return false;
  return Object.values(value.profiles).every(
    (profile) =>
      isRecord(profile) &&
      ['url', 'token', 'org', 'workspace'].every(
        (key) => profile[key] === undefined || typeof profile[key] === 'string',
      ),
  );
}

function checkedProfileName(name: string): string {
  if (FORBIDDEN_PROFILE_NAMES.includes(name)) throw usage('接続先の名前に使えない');
  return name;
}

const hasProfile = (config: Config, name: string) => Object.hasOwn(config.profiles, name);

// message に URL を入れない（認証情報が入りうる）
function checkedUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw usage(URL_MESSAGE);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw usage(URL_MESSAGE);
  if (url.username !== '' || url.password !== '') throw usage(URL_MESSAGE);
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.includes(url.hostname)) throw usage(URL_MESSAGE);
  // 後ろに /api/<操作名> を足すので、問い合わせと断片があると宛先が壊れる。末尾の ? だけは url.search が空になるので、元の文字列で見る
  if (raw.includes('?') || raw.includes('#')) throw usage(URL_MESSAGE);
  return raw.replace(/\/+$/, '');
}

async function configCommand(args: string[], deps: CliDeps): Promise<number> {
  const { options, positional } = optionsOf(args);
  if (options.extra.length > 0 || options.org !== undefined || options.workspace !== undefined) {
    throw usage('config に余分な引数がある');
  }
  const config = (await readConfig(deps)) ?? { profiles: {} };
  if (positional[0] === 'set') {
    const key = positional[1] as 'url' | 'org' | 'workspace' | 'token' | undefined;
    if (!key || !['url', 'org', 'workspace', 'token'].includes(key)) throw usage('config set の項目が不正');
    if (key === 'token') {
      if (positional.length !== 2) throw usage('token は標準入力から指定する');
    } else {
      if (positional.length !== 3 || positional[2] === undefined) throw usage('config set の値が無い');
    }
    const profileName = checkedProfileName(
      options.profile ?? envOf(deps, 'SG_PROFILE') ?? config.default_profile ?? 'main',
    );
    let value = positional[2]!;
    if (key === 'url') value = checkedUrl(value);
    if (key === 'token') {
      value = (await deps.readStdin()).replace(/(?:\r\n|\n|\r)+$/, '');
      if (value === '') throw usage('標準入力のトークンが空');
    }
    const next = structuredClone(config);
    if (!hasProfile(next, profileName)) next.profiles[profileName] = {};
    next.profiles[profileName]![key] = value;
    await writeConfig(deps, next);
    return 0;
  }
  if (positional[0] === 'use') {
    const name = positional[1];
    if (positional.length !== 2 || name === undefined || !hasProfile(config, checkedProfileName(name))) {
      throw usage('存在する接続先を指定する');
    }
    config.default_profile = name;
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

export type Options = { profile?: string; org?: string; workspace?: string; extra: string[] };

function optionsOf(args: string[]): { positional: string[]; options: Options } {
  const positional: string[] = [];
  const options: Options = { extra: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw usage(`--${key} の値が無い`);
    if (key === 'profile' || key === 'org' || key === 'workspace') {
      if (options[key] !== undefined) throw usage(`--${key} が重なっている`);
      options[key] = value;
    } else options.extra.push(key, value);
  }
  return { positional, options };
}

async function jsonOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new CliError('invalid_response', '応答が JSON でない');
  }
}

const SCOPES = ['outside', 'organization', 'workspace'];
function isCatalog(body: unknown): body is { operations: CatalogOperation[] } {
  return (
    isRecord(body) &&
    Array.isArray(body.operations) &&
    body.operations.every(
      (item) =>
        isRecord(item) &&
        typeof item.name === 'string' &&
        typeof item.scope === 'string' &&
        SCOPES.includes(item.scope) &&
        isRecord(item.input_schema),
    )
  );
}

export async function catalogFor(deps: CliDeps, connection: Connection): Promise<CatalogOperation[]> {
  const response = await request(deps, connection, '/api/operation-list', {});
  if (!response.ok) throw await apiError(response);
  const body = await jsonOf(response);
  if (!isCatalog(body)) throw new CliError('invalid_response', '操作一覧の応答の形が不正');
  return body.operations;
}

async function opsCommand(args: string[], deps: CliDeps): Promise<number> {
  const { positional, options } = optionsOf(args);
  if (positional.length > 1) throw usage('ops の操作名が多い');
  if (options.extra.length > 0) throw usage('ops に余分な引数がある');
  const connection = await connectionOf(options, deps);
  const catalog = await catalogFor(deps, connection);
  const operation = positional[0] === undefined ? undefined : catalog.find((item) => item.name === positional[0]);
  if (positional[0] !== undefined && operation === undefined) throw usage(UNLISTED_OPERATION);
  deps.stdout(JSON.stringify(operation ?? { operations: catalog }, null, 2) + '\n');
  return 0;
}

export type Connection = { url: string; token: string; org?: string; workspace?: string };
export async function connectionOf(options: Options, deps: CliDeps): Promise<Connection> {
  const config = (await readConfig(deps)) ?? { profiles: {} };
  const name = checkedProfileName(options.profile ?? envOf(deps, 'SG_PROFILE') ?? config.default_profile ?? 'main');
  const profile = hasProfile(config, name) ? config.profiles[name] : undefined;
  if (options.profile !== undefined && profile === undefined) throw usage('接続先が無い');
  // URL とトークンは同じ出どころから取る（片方だけ環境変数だと、別のサーバーへ設定のトークンを送りかねない）
  const envUrl = envOf(deps, 'SG_URL');
  const envToken = envOf(deps, 'SG_TOKEN');
  if ((envUrl === undefined) !== (envToken === undefined)) throw usage('SG_URL と SG_TOKEN は両方を設定する');
  const url = envUrl ?? profile?.url;
  const token = envToken ?? profile?.token;
  if (!url || !token) throw usage('url と token の設定が必要');
  // 空白や改行を含む値は Authorization ヘッダーに置けず、fetch の誤りの message に値が入る。送る前に止める（値は出さない）
  if (!HEADER_SAFE_TOKEN.test(token)) throw usage('token に使えない文字がある（空白、改行、ASCII 以外）');
  return {
    url: checkedUrl(url),
    token,
    org: options.org ?? envOf(deps, 'SG_ORG') ?? profile?.org,
    workspace: options.workspace ?? envOf(deps, 'SG_WORKSPACE') ?? profile?.workspace,
  };
}

function hasNonFiniteNumber(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasNonFiniteNumber);
  if (isRecord(value)) return Object.values(value).some(hasNonFiniteNumber);
  return false;
}

function parseInput(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw usage('JSON が不正');
  }
  if (!isRecord(parsed)) throw usage('JSON が不正');
  // 1e400 は JSON.parse が Infinity にし、JSON.stringify が null に変えて送ってしまう
  if (hasNonFiniteNumber(parsed)) throw usage('JSON に有限でない数がある');
  return parsed;
}

async function callCommand(args: string[], deps: CliDeps): Promise<number> {
  const { positional, options } = optionsOf(args);
  const name = positional.shift();
  if (!name || positional.length > 1) throw usage('call の操作名または JSON が不正');
  const keys = options.extra.filter((_, index) => index % 2 === 0);
  if (new Set(keys).size !== keys.length) throw usage('同じ項目の引数が重なっている');
  // つながる前に確かめられる誤りは、サーバーに問い合わせる前に 2 にする
  const input = parseInput(positional[0]);
  const connection = await connectionOf(options, deps);
  const catalog = await catalogFor(deps, connection);
  const operation = catalog.find((item) => item.name === name);
  if (!operation) throw usage(UNLISTED_OPERATION);
  for (let i = 0; i < options.extra.length; i += 2) {
    const key = options.extra[i]!;
    const value = options.extra[i + 1]!;
    input[key] = valueOf(value, propertySchema(operation.input_schema, key));
  }
  deps.stdout(JSON.stringify(await callOperation(deps, connection, operation, input), null, 2) + '\n');
  return 0;
}

// 一覧にある操作を呼ぶ。組織の slug とワークスペースの ID を補い、API のエラーは ApiCliError で投げる。sg call と sg mcp が共通に使う。input は書き換える
export async function callOperation(
  deps: CliDeps,
  connection: Connection,
  operation: CatalogOperation,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (operation.scope !== 'outside' && !connection.org) throw usage('org が必要');
  if (operation.scope === 'workspace' && input.workspace_id === undefined) {
    if (!connection.workspace) throw usage('workspace が必要');
    input.workspace_id = connection.workspace;
  }
  const path =
    operation.scope === 'outside'
      ? `/api/${operation.name}`
      : `/api/${encodeURIComponent(connection.org!)}/${operation.name}`;
  const response = await request(deps, connection, path, input);
  if (!response.ok) throw await apiError(response);
  return await jsonOf(response);
}

// sg mcp の引数（--profile、--org、--workspace だけ）から接続先を決める。sg call と同じ順で補う
export async function connectionFromArgs(args: string[], deps: CliDeps): Promise<Connection> {
  const { positional, options } = optionsOf(args);
  if (positional.length > 0 || options.extra.length > 0) throw usage('mcp に余分な引数がある');
  return await connectionOf(options, deps);
}

// 最上位が oneOf/anyOf（discriminatedUnion）の入力は、分岐のどれかに項目があれば受け付け、分岐ごとの Schema を anyOf にまとめる
function propertySchema(input: JsonSchema, key: string): JsonSchema | undefined {
  const found = [input, ...(input.oneOf ?? []), ...(input.anyOf ?? [])]
    .map((schema) =>
      schema.properties !== undefined && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined,
    )
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
  if (NUMBER_PATTERN.test(raw)) {
    const value = Number(raw);
    if (types.includes('number') && Number.isFinite(value)) return value;
    if (types.includes('integer') && Number.isSafeInteger(value)) return value;
  }
  if (types.includes('string')) return raw;
  const wanted = ['boolean', 'integer', 'number'].find((type) => types.includes(type));
  if (wanted) throw usage(`${wanted} の値が不正`);
  throw usage('引数の型を変えられない');
}

// リダイレクトは追わない（Authorization を別のサーバーへ送らない）。Workers の実行環境は 'error' を投げるので 'manual' にし、3xx は !ok として扱う
export async function request(deps: CliDeps, connection: Connection, path: string, body: unknown): Promise<Response> {
  try {
    return await deps.fetch(`${connection.url}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'manual',
    });
  } catch (error) {
    // fetch の誤りの message にヘッダーの値が入ることがあるので、トークンは伏せる
    throw new CliError('connection_failed', messageOf(error).split(connection.token).join('********'));
  }
}

export async function apiError(response: Response): Promise<ApiCliError> {
  let error: unknown;
  try {
    error = ((await response.json()) as { error?: unknown }).error;
  } catch {
    error = undefined;
  }
  return new ApiCliError(JSON.stringify({ status: response.status, error }));
}
