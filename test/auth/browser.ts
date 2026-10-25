// ログインの結合テストで使う、Cookie を持つ疑似のブラウザ。アプリに直に流し、リダイレクトは辿らず、Location を返す
import { createApp } from '../../src/server/app.ts';
import { implementedOperations } from '../../src/server/operations/index.ts';
import { operationPath, type AnyOperationDefinition } from '../../src/shared/operations/define.ts';
import { testEnv } from '../operations/world.ts';
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, type FakeGithub, type FakeGithubUser } from './fake-github.ts';
import {
  createFakeGoogle,
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CLIENT_SECRET,
  GOOGLE_TOKEN_URL,
  type FakeGoogle,
  type FakeGoogleUser,
  type IdTokenClaims,
} from './fake-google.ts';

export const loginEnv: Env = Object.assign({}, testEnv, {
  GITHUB_CLIENT_ID: FAKE_CLIENT_ID,
  GITHUB_CLIENT_SECRET: FAKE_CLIENT_SECRET,
  GOOGLE_CLIENT_ID: FAKE_GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: FAKE_GOOGLE_CLIENT_SECRET,
});

export const SESSION_COOKIE = '__Host-sg_session';
export const STATE_COOKIE = '__Host-sg_oauth_state';

let browserCount = 0;

// アプリに渡す fetcher は、Google のトークンのエンドポイントを Google の偽物へ、ほかを GitHub の偽物へ振り分ける
export function createLoginApp(github: FakeGithub, google: FakeGoogle = createFakeGoogle()) {
  const fetcher: typeof fetch = (input, init) =>
    String(input) === GOOGLE_TOKEN_URL ? google.fetcher(input, init) : github.fetcher(input, init);
  return createApp(implementedOperations, { fetcher });
}

export type LoginProvider = 'github' | 'google';

export type StartedLogin = { response: Response; location: URL; state: string; challenge: string };
export type FinishedLogin = { response: Response; location: string };

export class FakeBrowser {
  readonly cookies = new Map<string, string>();
  // 同じ IP から来るブラウザごとに別の値を振る（レート制限は IP ごとに数えるので、テストどうしが数え合わない）
  readonly ip: string;
  readonly #app: ReturnType<typeof createLoginApp>;
  readonly #github: FakeGithub;
  readonly #google: FakeGoogle | undefined;
  readonly #env: Env;
  // start と callback が叩く手段
  provider: LoginProvider = 'github';

  constructor(
    app: ReturnType<typeof createLoginApp>,
    github: FakeGithub,
    env: Env = loginEnv,
    ip?: string,
    google?: FakeGoogle,
  ) {
    this.#app = app;
    this.#github = github;
    this.#google = google;
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
    const response = await this.request(`/api/auth/${this.provider}/start${query}`, { headers });
    const location = new URL(response.headers.get('Location') ?? '', 'https://scrum-guild.test');
    return {
      response,
      location,
      state: location.searchParams.get('state') ?? '',
      challenge: location.searchParams.get('code_challenge') ?? '',
    };
  }

  // 招待の URL の画面（/invite）のフォームの POST。ブラウザがフォームを送るときと同じヘッダー（同じオリジンからの画面の移動）を付ける。
  // body と contentType を渡すと、本文をそのまま送る（形の違う本文の確かめ）
  async startInvite(
    claimToken: string,
    options: { headers?: Record<string, string>; body?: string; contentType?: string } = {},
  ): Promise<StartedLogin> {
    const response = await this.request('/api/auth/google/start', {
      method: 'POST',
      headers: {
        'Content-Type': options.contentType ?? 'application/x-www-form-urlencoded',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Site': 'same-origin',
        ...options.headers,
      },
      body: options.body ?? new URLSearchParams({ claim_token: claimToken }).toString(),
    });
    const location = new URL(response.headers.get('Location') ?? '', 'https://scrum-guild.test');
    return {
      response,
      location,
      state: location.searchParams.get('state') ?? '',
      challenge: location.searchParams.get('code_challenge') ?? '',
    };
  }

  // 招待の URL から Google の認可の画面を通った人の戻り。claims で ID トークンの中身を上書きできる
  async loginWithInvite(user: FakeGoogleUser, claimToken: string, options: { claims?: IdTokenClaims } = {}) {
    if (this.#google === undefined) throw new Error('FakeBrowser に Google の偽物を渡していない');
    const previous = this.provider;
    this.provider = 'google';
    try {
      const started = await this.startInvite(claimToken);
      const code = this.#google.issueCode(user, started.location, options.claims);
      const finished = await this.callback({ code, state: started.state });
      return { started, code, ...finished };
    } finally {
      this.provider = previous;
    }
  }

  async callback(query: Record<string, string>): Promise<FinishedLogin> {
    const response = await this.request(`/api/auth/${this.provider}/callback?${new URLSearchParams(query).toString()}`);
    return { response, location: response.headers.get('Location') ?? '' };
  }

  // Google の認可の画面を通った人の戻り。claims で ID トークンの中身を上書きできる
  async loginWithGoogle(user: FakeGoogleUser, options: { returnTo?: string; claims?: IdTokenClaims } = {}) {
    if (this.#google === undefined) throw new Error('FakeBrowser に Google の偽物を渡していない');
    const previous = this.provider;
    this.provider = 'google';
    try {
      const started = await this.start(options.returnTo);
      const code = this.#google.issueCode(user, started.location, options.claims);
      const finished = await this.callback({ code, state: started.state });
      return { started, code, ...finished };
    } finally {
      this.provider = previous;
    }
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
