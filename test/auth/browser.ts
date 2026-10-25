// ログインの結合テストで使う、Cookie を持つ疑似のブラウザ。アプリに直に流し、リダイレクトは辿らず、Location を返す
import { createApp } from '../../src/server/app.ts';
import { implementedOperations } from '../../src/server/operations/index.ts';
import { operationPath, type AnyOperationDefinition } from '../../src/shared/operations/define.ts';
import { testEnv } from '../operations/world.ts';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, type FakeGithub, type FakeGithubUser } from './fake-github.ts';

export const loginEnv: Env = Object.assign({}, testEnv, {
  GITHUB_CLIENT_ID: FAKE_CLIENT_ID,
  GITHUB_CLIENT_SECRET: FAKE_CLIENT_SECRET,
});

export const SESSION_COOKIE = '__Host-sg_session';
export const STATE_COOKIE = '__Host-sg_oauth_state';

let browserCount = 0;

export function createLoginApp(github: FakeGithub) {
  return createApp(implementedOperations, { fetcher: github.fetcher });
}

export type StartedLogin = { response: Response; location: URL; state: string; challenge: string };
export type FinishedLogin = { response: Response; location: string };

export class FakeBrowser {
  readonly cookies = new Map<string, string>();
  // 同じ IP から来るブラウザごとに別の値を振る（レート制限は IP ごとに数えるので、テストどうしが数え合わない）
  readonly ip: string;
  readonly #app: ReturnType<typeof createLoginApp>;
  readonly #github: FakeGithub;
  readonly #env: Env;

  constructor(app: ReturnType<typeof createLoginApp>, github: FakeGithub, env: Env = loginEnv, ip?: string) {
    this.#app = app;
    this.#github = github;
    this.#env = env;
    this.ip = ip ?? `198.51.100.${++browserCount}`;
  }

  #remember(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split('; ');
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const expired = attributes.some((attribute) => attribute.toLowerCase() === 'max-age=0');
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set('Cookie', [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    }
    if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', this.ip);
    const response = await this.#app.request(
      path,
      { ...init, headers, redirect: 'manual' },
      this.#env,
      this.useExecutionContext ? this.#executionContext : undefined,
    );
    this.#remember(response);
    return response;
  }

  // waitUntil で渡された仕事（トークンの取り消しなど）。応答の後に走らせるので、見るときは settle() で待つ
  readonly background: Promise<unknown>[] = [];
  // false にすると、実行の文脈（ExecutionContext）を渡さずに呼ぶ（Hono の executionCtx が投げる分岐を通す）
  useExecutionContext = true;
  readonly #executionContext = {
    waitUntil: (work: Promise<unknown>) => void this.background.push(work),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;

  async settle(): Promise<void> {
    await Promise.all(this.background);
  }

  async start(returnTo?: string, headers?: Record<string, string>): Promise<StartedLogin> {
    const query = returnTo === undefined ? '' : `?return_to=${encodeURIComponent(returnTo)}`;
    const response = await this.request(`/api/auth/github/start${query}`, { headers });
    const location = new URL(response.headers.get('Location') ?? '', 'https://scrum-guild.test');
    return {
      response,
      location,
      state: location.searchParams.get('state') ?? '',
      challenge: location.searchParams.get('code_challenge') ?? '',
    };
  }

  async callback(query: Record<string, string>): Promise<FinishedLogin> {
    const response = await this.request(`/api/auth/github/callback?${new URLSearchParams(query).toString()}`);
    return { response, location: response.headers.get('Location') ?? '' };
  }

  // GitHub の認可の画面を通った人の戻り。start で認可の URL を作り、GitHub が code を渡し、戻り先を開くまでを通す
  async login(user: FakeGithubUser, options: { returnTo?: string } = {}) {
    const started = await this.start(options.returnTo);
    const code = this.#github.issueCode(user, started.challenge);
    const finished = await this.callback({ code, state: started.state });
    return { started, code, ...finished };
  }

  async post(definition: AnyOperationDefinition, body: unknown = {}): Promise<Response> {
    return this.request(operationPath(definition), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: this.#env.PUBLIC_ORIGIN },
      body: JSON.stringify(body),
    });
  }

  get sessionToken(): string | undefined {
    return this.cookies.get(SESSION_COOKIE);
  }
}
