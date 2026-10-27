import { expect, type Page, type Route } from '@playwright/test';
import { z } from 'zod';
import type { ErrorBody, ErrorCode } from '../src/shared/errors.ts';
import {
  isOutsideOperation,
  operationPath,
  type AnyOperationDefinition,
  type InputOf,
  type OutputOf,
  type OutsideOperationDefinition,
} from '../src/shared/operations/define.ts';

// e2e で操作の応答を差し替えるヘルパー（docs/development.md の「e2e の書き方」）。page.route を直に書かず、ここを通す。
// URL、入力の型、出力の型を操作の定義から導き、届いた入力と返す出力を実行時にも定義のスキーマで確かめる。
// どれも、張った route だけを外す関数を返す。テストの後の後始末は e2e/fixtures.ts がする。
// fixture が効くのはテストの引数の page だけで、自分で newPage した page では、テストの終わりに自分で unrouteAll を待つ

// 組織の中の操作は slug を要る。組織の外の操作には渡せない（src/lib/api.ts の CallArguments と同じ作り）
type ScopeArguments<D extends AnyOperationDefinition> = D extends OutsideOperationDefinition
  ? []
  : [scope: { slug: string }];

type FailOptions = { details?: unknown; message?: string };

export type OperationCall<D extends AnyOperationDefinition> = {
  // 画面が送った入力。定義の入力のスキーマに通ったものだけが届く
  readonly input: InputOf<D>;
  // Playwright の route そのもの。スキーマに合わない本文を返すときの抜け道
  readonly route: Route;
  // 本物の API へ流す
  passThrough(): Promise<void>;
  // 本物の API の出力を受け取る。失敗の応答ならテストを落とす
  fetch(): Promise<OutputOf<D>>;
  // 出力を返す。返す前に定義の出力のスキーマで確かめる
  fulfill(output: OutputOf<D>): Promise<void>;
  // API のエラーの形で返す。message は省けば code と同じ
  fail(status: number, code: ErrorCode, options?: FailOptions): Promise<void>;
  // 通信を失敗させる
  abort(): Promise<void>;
};

type Unroute = () => Promise<void>;

// route の処理の中で throw しても、テストは落ちないことがある。expect.soft でそのテストに失敗を付け、
// 画面が待ち続けないよう 500 を返す。文言には操作の名前と、合わない項目の path（z.prettifyError の「→ at」）を含める
async function rejectCall(route: Route, message: string): Promise<void> {
  expect.soft(false, message).toBe(true);
  const body: ErrorBody = { error: { code: 'internal', message } };
  await route.fulfill({ status: 500, json: body });
}

// 失敗をもう付けた throw。route の処理の catch で、二重に付けない
class ReportedError extends Error {}

// route.fetch() そのものの失敗（テストの終わり、通信の失敗）。失敗を付けずに元のまま投げ直す
class FetchError extends Error {
  constructor(cause: unknown) {
    super(String(cause), { cause });
  }
}

// スキーマに通す前の値にあって、通した後の値に無い項目の path。undefined の項目は JSON に出ないので数えない
export function droppedPaths(given: unknown, parsed: unknown, path: readonly string[] = []): string[] {
  if (Array.isArray(given) && Array.isArray(parsed)) {
    return given.flatMap((item: unknown, index) => droppedPaths(item, parsed[index], [...path, String(index)]));
  }
  if (!isPlainObject(given) || !isPlainObject(parsed)) return [];
  return Object.entries(given).flatMap(([key, value]) => {
    if (value === undefined) return [];
    if (!Object.hasOwn(parsed, key)) return [[...path, key].join('.')];
    return droppedPaths(value, parsed[key], [...path, key]);
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function splitScope<D extends AnyOperationDefinition, Rest extends unknown[]>(
  definition: D,
  args: [...ScopeArguments<D>, ...Rest],
): { slug: string | undefined; rest: Rest } {
  if (isOutsideOperation(definition)) return { slug: undefined, rest: args as unknown as Rest };
  const [scope, ...rest] = args as unknown as [{ slug: string }, ...Rest];
  return { slug: scope.slug, rest };
}

// 土台。handler は、入力がスキーマに通ったときだけ呼ぶ
export async function routeOperation<D extends AnyOperationDefinition>(
  page: Page,
  definition: D,
  ...args: [...ScopeArguments<D>, handler: (call: OperationCall<D>) => Promise<void> | void]
): Promise<Unroute> {
  const {
    slug,
    rest: [handler],
  } = splitScope<D, [(call: OperationCall<D>) => Promise<void> | void]>(definition, args);
  const url = `**${operationPath(definition, slug)}`;
  const name = definition.name;
  const routeHandler = async (route: Route) => {
    // 応答を返したか。処理が途中で throw したとき、まだ返していなければ失敗を付けて 500 を返す
    let answered = false;
    const answer = <T>(promise: Promise<T>): Promise<T> => {
      answered = true;
      return promise;
    };
    let body: unknown;
    try {
      body = route.request().postDataJSON();
    } catch {
      await rejectCall(route, `操作 ${name} の入力が JSON でない`);
      return;
    }
    const input = definition.input.safeParse(body);
    if (!input.success) {
      await rejectCall(route, `操作 ${name} の入力が定義のスキーマに合わない\n${z.prettifyError(input.error)}`);
      return;
    }
    const call: OperationCall<D> = {
      input: body as InputOf<D>,
      route,
      passThrough: () => answer(route.continue()),
      fetch: async () => {
        const response = await route.fetch().catch((error: unknown) => {
          throw new FetchError(error);
        });
        const json: unknown = await response.json().catch(() => undefined);
        if (json === undefined && response.ok()) {
          // 転送が効かず index.html が返ったときなど。書き換えの続きは throw で止め、下の catch が失敗を付ける
          throw new Error(`操作 ${name} の本物の応答が JSON でない（${response.status()}）`);
        }
        if (!response.ok()) {
          // 失敗の応答はそのまま画面へ渡し、書き換えの続きは throw で止める
          const message = `操作 ${name} の本物の応答が失敗した（${response.status()}）: ${JSON.stringify(json)}`;
          expect.soft(false, message).toBe(true);
          await answer(route.fulfill({ response }));
          throw new ReportedError(message);
        }
        // サーバーが出力のスキーマで検証した値。出力のスキーマに変換は無いので、そのまま出力の型で渡す
        return json as OutputOf<D>;
      },
      fulfill: async (output) => {
        const parsed = definition.output.safeParse(output);
        if (!parsed.success) {
          await answer(
            rejectCall(route, `操作 ${name} の出力が定義のスキーマに合わない\n${z.prettifyError(parsed.error)}`),
          );
          return;
        }
        // z.object は定義に無い項目を黙って落とす。書き換えで名前を間違えた項目も、型の検査を抜けることがあるので止める
        const unknown = droppedPaths(output, parsed.data);
        if (unknown.length > 0) {
          await answer(rejectCall(route, `操作 ${name} の出力に定義のスキーマに無い項目がある: ${unknown.join(', ')}`));
          return;
        }
        // サーバーと同じく、スキーマに通した値を返す
        await answer(route.fulfill({ status: 200, json: parsed.data }));
      },
      fail: async (status, code, options = {}) => {
        const error: ErrorBody['error'] = { code, message: options.message ?? code };
        if ('details' in options) error.details = options.details;
        await answer(route.fulfill({ status, json: { error } satisfies ErrorBody }));
      },
      abort: () => answer(route.abort()),
    };
    try {
      await handler(call);
    } catch (error) {
      if (error instanceof ReportedError) return;
      // テストの後の「route.fetch: Test ended」は、元の失敗のまま投げ、fixture の unrouteAll（ignoreErrors）に捨てさせる
      if (error instanceof FetchError) throw error.cause;
      const message = `操作 ${name} の route の処理が失敗した: ${String(error)}`;
      if (answered) expect.soft(false, message).toBe(true);
      else await rejectCall(route, message);
    }
  };
  await page.route(url, routeHandler);
  return () => page.unroute(url, routeHandler);
}

// 出力を差し替える
export async function mockOperation<D extends AnyOperationDefinition>(
  page: Page,
  definition: D,
  ...args: [...ScopeArguments<D>, output: OutputOf<D>]
): Promise<Unroute> {
  const {
    slug,
    rest: [output],
  } = splitScope<D, [OutputOf<D>]>(definition, args);
  return routeOperation(page, definition, ...withScope(definition, slug, (call) => call.fulfill(output)));
}

// 本物の出力を書き換えて返す
export async function rewriteOperation<D extends AnyOperationDefinition>(
  page: Page,
  definition: D,
  ...args: [...ScopeArguments<D>, change: (output: OutputOf<D>) => OutputOf<D>]
): Promise<Unroute> {
  const {
    slug,
    rest: [change],
  } = splitScope<D, [(output: OutputOf<D>) => OutputOf<D>]>(definition, args);
  return routeOperation(
    page,
    definition,
    ...withScope(definition, slug, async (call) => call.fulfill(change(await call.fetch()))),
  );
}

// エラーを返す。status と code の対応は確かめない（わざと崩した組み合わせも書ける）
export async function failOperation<D extends AnyOperationDefinition>(
  page: Page,
  definition: D,
  ...args: [...ScopeArguments<D>, status: number, code: ErrorCode, options?: FailOptions]
): Promise<Unroute> {
  const {
    slug,
    rest: [status, code, options],
  } = splitScope<D, [number, ErrorCode, FailOptions?]>(definition, args);
  return routeOperation(page, definition, ...withScope(definition, slug, (call) => call.fail(status, code, options)));
}

// 短縮形から土台へ、slug を付け直して渡す
function withScope<D extends AnyOperationDefinition>(
  definition: D,
  slug: string | undefined,
  handler: (call: OperationCall<D>) => Promise<void> | void,
): [...ScopeArguments<D>, (call: OperationCall<D>) => Promise<void> | void] {
  const args = isOutsideOperation(definition) ? [handler] : [{ slug: slug! }, handler];
  return args as [...ScopeArguments<D>, (call: OperationCall<D>) => Promise<void> | void];
}
