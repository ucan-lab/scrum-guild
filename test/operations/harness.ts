// 操作の一覧を回して、組織の分離と権限を確かめる仕組み。新しい操作を一覧に足しても、テストを書き足す必要はない。
// 足すのは、組織の中の操作ごとのテスト用の関数（Pointer）だけで、足し忘れるとテストが落ちる
import { beforeAll, describe, expect, test } from 'vitest';
import {
  isOutsideOperation,
  isWorkspaceOperation,
  operationPath,
  type AnyOperationDefinition,
} from '../../src/shared/operations/define.ts';
import { sessionCookieName } from '../../src/shared/session-cookie.ts';
import { createApp } from '../../src/server/app.ts';
import type { ImplementedOperation } from '../../src/server/operations/implement.ts';
import {
  admitElsewhere,
  createPerson,
  createTarget,
  getOperator,
  testEnv,
  withNewSession,
  type Person,
  type Target,
} from './world.ts';

// 対象の組織の行を指す、成功する入力を作る。別の組織の対象を渡すと、同じ入力が 404 になる。
// 入力が組織の中の行を指さない操作は、成功する入力を noReference に書く（分離の検査はスラッグだけになる）。
// 入力に `_id` で終わる項目がある操作には書けない（行を指しているので、関数で作る）
// caller は、その入力で呼ぶ人。届いた招待の承諾と辞退のように、呼んだ人に宛てた行を指す操作が使う（省略は対象の組織の管理者）
export type Pointer = ((target: Target, caller: Person) => Promise<unknown>) | { noReference: unknown };
export type Pointers = Readonly<Record<string, Pointer>>;

type App = ReturnType<typeof createApp>;

// 入力のスキーマの項目名。オブジェクト以外のスキーマは調べられないので、noReference を認めない
function inputKeys(definition: AnyOperationDefinition): string[] | undefined {
  const shape = (definition.input as { shape?: Record<string, unknown> }).shape;
  return shape === undefined ? undefined : Object.keys(shape);
}

// テスト用の関数の無い組織の中の操作と、操作の無い関数があれば落とす。
// noReference を付けた操作の入力に `_id` で終わる項目があっても落とす（行を指す入力を、分離の検査から外さないため）
export function assertPointersCover(operations: readonly ImplementedOperation[], pointers: Pointers): void {
  const names = operations.map((operation) => operation.definition.name);
  const missing = operations
    .filter((operation) => !isOutsideOperation(operation.definition))
    .map((operation) => operation.definition.name)
    .filter((name) => !(name in pointers));
  if (missing.length > 0) {
    throw new Error(
      `組織の分離のテスト用の関数が無い操作: ${missing.join(', ')}（test/operations/pointers.ts に足す）`,
    );
  }
  const stale = Object.keys(pointers).filter((name) => !names.includes(name));
  if (stale.length > 0) throw new Error(`一覧に無い操作のテスト用の関数: ${stale.join(', ')}`);

  for (const { definition } of operations) {
    const pointer = pointers[definition.name];
    if (pointer === undefined || typeof pointer === 'function') continue;
    const keys = inputKeys(definition);
    if (keys === undefined) {
      throw new Error(
        `${definition.name}: 入力のスキーマが項目を持つオブジェクトでないので、noReference を認められない`,
      );
    }
    const idKeys = keys.filter((key) => key.endsWith('_id'));
    if (idKeys.length > 0) {
      throw new Error(
        `${definition.name}: 入力に ${idKeys.join(', ')} があるので、noReference ではなく関数で行を指す入力を作る`,
      );
    }
  }
}

type PostOptions = {
  slug?: string;
  token?: string;
  // null は Origin を付けない。省略は公開する URL
  origin?: string | null;
  body?: unknown;
  rawBody?: string | ReadableStream<Uint8Array>;
  headers?: Record<string, string>;
  env?: Env;
  // 渡すと、本番と同じ waitUntil の経路を通る（省略は ExecutionContext の無い呼び出し）
  executionCtx?: ExecutionContext;
};

export async function post(app: App, definition: AnyOperationDefinition, options: PostOptions = {}): Promise<Response> {
  const env = options.env ?? testEnv;
  const headers = new Headers({ 'Content-Type': 'application/json', ...options.headers });
  const origin = options.origin === undefined ? env.PUBLIC_ORIGIN : options.origin;
  if (origin !== null) headers.set('Origin', origin);
  if (options.token !== undefined) {
    headers.set('Cookie', `${sessionCookieName(env.PUBLIC_ORIGIN)}=${options.token}`);
  }
  const body = options.rawBody ?? JSON.stringify(options.body ?? {});
  return app.request(
    operationPath(definition, options.slug),
    // 本文が ReadableStream のときは Content-Length が付かない（chunked と同じ）
    { method: 'POST', headers, body, ...(typeof body === 'string' ? {} : { duplex: 'half' }) } as RequestInit,
    env,
    options.executionCtx,
  );
}

export async function errorCodeOf(res: Response): Promise<string | undefined> {
  const body: unknown = await res.json();
  return (body as { error?: { code?: string } }).error?.code;
}

export async function inputFor(
  pointers: Pointers,
  definition: AnyOperationDefinition,
  target: Target,
  caller: Person = target.admin,
): Promise<unknown> {
  const pointer = pointers[definition.name];
  if (pointer === undefined) return {};
  return typeof pointer === 'function' ? pointer(target, caller) : pointer.noReference;
}

// 自分の組織の行を指す入力は成功し、別の組織の行を指す入力は 404 になる。404 が入力の誤りや権限の不足ではなく、
// 別の組織の行を指したことで返ったと言えるよう、同じ関数が作った入力の2つの結果を対にして見る。
// 組織で絞らない処理を渡すと、ここで落ちる（test/operation-registry.test.ts が確かめる）
export async function checkRowIsolation(
  app: App,
  definition: AnyOperationDefinition,
  pointers: Pointers,
  own: Target,
  other: Target,
): Promise<void> {
  const ok = await post(app, definition, {
    slug: own.slug,
    token: own.admin.token,
    body: await inputFor(pointers, definition, own, own.admin),
  });
  expect(ok.status, '自分の組織の行を指す入力').toBe(200);
  const pointer = pointers[definition.name];
  if (typeof pointer !== 'function') return;
  const res = await post(app, definition, {
    slug: own.slug,
    token: own.admin.token,
    body: await inputFor(pointers, definition, other, own.admin),
  });
  expect(res.status, '別の組織の行を指す入力').toBe(404);
  expect(await errorCodeOf(res)).toBe('not_found');
}

// options.fetcher は、ログインの手段（GitHub）への通信の差し替え。運用者の操作が GitHub に問い合わせるときに渡す
export function defineOperationChecks(
  operations: readonly ImplementedOperation[],
  pointers: Pointers,
  options: { fetcher?: typeof fetch } = {},
): void {
  const app = createApp(operations, options);

  describe.each(operations.map((operation) => operation.definition))('$name（$permission）', (definition) => {
    let own: Target;
    let other: Target;
    let closed: Target;
    let suspended: Target;
    let operator: Person;
    beforeAll(async () => {
      [own, other, closed, suspended, operator] = await Promise.all([
        createTarget(),
        createTarget(),
        createTarget({ closed: true }),
        createTarget({ suspended: true }),
        getOperator().then(withNewSession),
      ]);
      // 停止した組織にしか入れない人は、403 の前にセッションを消されて 401 になる。ほかの組織にも入れる人にして、403 を見る
      await Promise.all(
        [suspended.admin, suspended.leader, suspended.member, suspended.bystander, suspended.invitee].map(
          admitElsewhere,
        ),
      );
    });

    // 成功の応答が定義の出力の形であることまで確かめる
    const expectOk = async (res: Response) => {
      expect(res.status).toBe(200);
      expect(definition.output.safeParse(await res.json()).success).toBe(true);
    };
    const input = (target: Target, caller?: Person) => inputFor(pointers, definition, target, caller);

    test('Origin が公開する URL と違う、または無いと 403', async () => {
      const token = (isOutsideOperation(definition) ? operator : own.admin).token;
      const body = await input(own);
      for (const origin of ['https://evil.example', `${testEnv.PUBLIC_ORIGIN}.evil.example`, null]) {
        const res = await post(app, definition, { slug: own.slug, token, origin, body });
        expect(res.status, String(origin)).toBe(403);
        expect(await errorCodeOf(res)).toBe('forbidden');
      }
    });

    test('ログインしていないと 401 の unauthenticated', async () => {
      const res = await post(app, definition, { slug: own.slug, body: await input(own) });
      expect(res.status).toBe(401);
      expect(await errorCodeOf(res)).toBe('unauthenticated');
    });

    if (isOutsideOperation(definition)) {
      test('ログインしている運用者は成功する', async () => {
        await expectOk(await post(app, definition, { token: operator.token, body: await input(own) }));
      });
      if (definition.permission === 'operator') {
        test('運用者でない人は 403', async () => {
          const res = await post(app, definition, { token: own.admin.token, body: await input(own) });
          expect(res.status).toBe(403);
          expect(await errorCodeOf(res)).toBe('forbidden');
        });
      }
      return;
    }

    test('別の組織の人は、その組織の slug で 404', async () => {
      const res = await post(app, definition, { slug: own.slug, token: other.admin.token, body: await input(own) });
      expect(res.status).toBe(404);
      expect(await errorCodeOf(res)).toBe('not_found');
    });

    test('存在しない slug は 404', async () => {
      const res = await post(app, definition, {
        slug: 'no-such-organization',
        token: own.admin.token,
        body: await input(own),
      });
      expect(res.status).toBe(404);
    });

    test('組織に属さない運用者は組織の中の操作に入れず 404', async () => {
      const res = await post(app, definition, { slug: own.slug, token: operator.token, body: await input(own) });
      expect(res.status).toBe(404);
    });

    test('自分の組織の行を指す入力は成功し、別の組織の行を指す入力は 404', () =>
      checkRowIsolation(app, definition, pointers, own, other));

    // 停止した組織は、停止していなければ入れた人（管理者、所属、承諾待ちの招待）にだけ停止を伝え、入れない人は組織が無いときと同じ 404。
    // 権限の検査より前なので、権限の種類によらず同じ結果になる
    test('停止した組織では、入れたはずの人に 403 の organization_suspended、入れない人に 404', async () => {
      const body = await input(suspended);
      for (const person of [
        suspended.admin,
        suspended.leader,
        suspended.member,
        suspended.bystander,
        suspended.invitee,
      ]) {
        const res = await post(app, definition, { slug: suspended.slug, token: person.token, body });
        expect(res.status).toBe(403);
        expect(await errorCodeOf(res)).toBe('organization_suspended');
      }
      // 入れない人。別の組織の管理者と、この組織で無効にされた管理者（ほかの組織には入れる）。
      // どの組織にも入れない人は、ログインできる条件を失って 401 になるので、ほかの組織に入れる人で見る
      const disabledAdmin = await admitElsewhere(
        await createPerson({ organization: suspended.organization, admin: true, disabled: true }),
      );
      for (const person of [other.admin, disabledAdmin]) {
        const res = await post(app, definition, { slug: suspended.slug, token: person.token, body });
        expect(res.status).toBe(404);
        expect(await errorCodeOf(res)).toBe('not_found');
      }
    });

    // 承諾待ちの招待だけの人には、招待の操作（invitee）以外を見せない。すべての権限の種類で当てる
    test('承諾待ちの招待だけの人は、invitee の操作だけに通る', async () => {
      const res = await post(app, definition, {
        slug: own.slug,
        token: own.invitee.token,
        body: await input(own, own.invitee),
      });
      if (definition.permission === 'invitee') {
        await expectOk(res);
      } else {
        expect(res.status).toBe(404);
        expect(await errorCodeOf(res)).toBe('not_found');
      }
    });

    const permission = definition.permission;
    switch (permission) {
      case 'invitee':
      case 'organization':
        // 入力は呼ぶ人ごとに作る（届いた招待の承諾のように、呼んだ人に宛てた行を指す操作のため）
        test('組織に入れる人は、所属がなくても成功する', async () => {
          for (const person of [own.admin, own.leader, own.member, own.bystander]) {
            await expectOk(
              await post(app, definition, { slug: own.slug, token: person.token, body: await input(own, person) }),
            );
          }
        });
        break;
      case 'admin':
        test('管理者でなければ 403', async () => {
          const body = await input(own);
          for (const person of [own.leader, own.member, own.bystander]) {
            const res = await post(app, definition, { slug: own.slug, token: person.token, body });
            expect(res.status).toBe(403);
            expect(await errorCodeOf(res)).toBe('forbidden');
          }
        });
        break;
      // 成功する呼び出しごとに入力を作り直す（タスクを完了にする操作のように、同じ入力で続けて呼ぶと 409 になる操作のため）
      case 'leader':
        test('一般のメンバーと所属していない人は 403、リーダーと管理者は成功する', async () => {
          for (const person of [own.member, own.bystander]) {
            const res = await post(app, definition, { slug: own.slug, token: person.token, body: await input(own) });
            expect(res.status).toBe(403);
            expect(await errorCodeOf(res)).toBe('forbidden');
          }
          for (const person of [own.leader, own.admin]) {
            await expectOk(
              await post(app, definition, { slug: own.slug, token: person.token, body: await input(own) }),
            );
          }
        });
        break;
      case 'member':
        test('所属していない人は 403、メンバーと管理者は成功する', async () => {
          const res = await post(app, definition, {
            slug: own.slug,
            token: own.bystander.token,
            body: await input(own),
          });
          expect(res.status).toBe(403);
          expect(await errorCodeOf(res)).toBe('forbidden');
          // 入力は呼ぶ人ごとに作る（自分のコメントを直すように、呼んだ人の行を指す操作のため）
          for (const person of [own.member, own.leader, own.admin]) {
            await expectOk(
              await post(app, definition, { slug: own.slug, token: person.token, body: await input(own, person) }),
            );
          }
        });
        break;
      default:
        // 組織の中の権限の種類を足したら、型の検査がここで落ちる。許可と拒否の検査を上に足す
        throw new Error(`検査を書いていない権限: ${String(permission satisfies never)}`);
    }

    // 閉じたワークスペースは読み取り専用。開き直す操作（allowClosed）だけが書き込める
    if (isWorkspaceOperation(definition)) {
      test('閉じたワークスペースへの書き込みは 409 の workspace_closed、読み取りと開き直す操作は成功する', async () => {
        const res = await post(app, definition, {
          slug: closed.slug,
          token: closed.admin.token,
          body: await input(closed),
        });
        if (definition.mode === 'write' && definition.allowClosed !== true) {
          expect(res.status).toBe(409);
          expect(await errorCodeOf(res)).toBe('workspace_closed');
        } else {
          await expectOk(res);
        }
      });
    }
  });
}
