// 入口の型の検査。実行はしない（vitest の対象は *.test.ts）。pnpm check の tsc が検査し、
// 期待したエラーの行が型の検査に通るようになると、使われていない期待として落ちる
import { env } from 'cloudflare:workers';
import { commonDb, orgDb, type Statement, type VerifiedOrganization } from '../src/server/db/index.ts';

const common = commonDb(env);
declare const verified: VerifiedOrganization;
const org = orgDb(env, verified);

// 共通の入口から組織の中の表は引けない
// @ts-expect-error tasks は組織の中の表
common.statement((q) => q.selectFrom('tasks').selectAll());
// @ts-expect-error users は組織の中の表
common.statement((q) => q.insertInto('users').values({}));

// 組織の中の入口から共通の表は引けない
// @ts-expect-error accounts は共通の表
org.statement((q) => q.selectFrom('accounts').selectAll());
org.statement((q) =>
  // @ts-expect-error organizations は共通の表なので、組織の中の表から結合もできない
  q.selectFrom('tasks').innerJoin('organizations', 'organizations.id', 'tasks.workspace_id').selectAll(),
);

// 入口の表の中でも、結合は同じ入口の表同士だけ
common.statement((q) =>
  q.selectFrom('accounts').innerJoin('sessions', 'sessions.account_id', 'accounts.id').selectAll(),
);

// 存在しない列は引けない
// @ts-expect-error accounts に name は無い
common.statement((q) => q.selectFrom('accounts').select('name'));

// INSERT では DEFAULT のある列と NULL を許す列を省ける。省けない列を省くと落ちる
common.statement((q) =>
  q.insertInto('organizations').values({
    id: 'x',
    slug: 'aoba',
    name: '青葉工房',
    created_by_operator: 'github:9000000000000001',
    created_at: 'x',
    updated_at: 'x',
  }),
);
common.statement((q) =>
  // @ts-expect-error created_by_operator は NOT NULL で DEFAULT が無いので省けない
  q.insertInto('organizations').values({ id: 'x', slug: 'aoba', name: '青葉工房', created_at: 'x', updated_at: 'x' }),
);

// 共通の文と組織の中の文を、1回の batch() に混ぜられない
const commonStatement = common.statement((q) => q.selectFrom('accounts').selectAll());
const orgStatement = org.statement((q) => q.selectFrom('tasks').selectAll());
void common.batch([commonStatement]);
void org.batch([orgStatement]);
// @ts-expect-error 組織の中の文を共通の入口の batch() に渡せない
void common.batch([commonStatement, orgStatement]);
// @ts-expect-error 共通の文を組織の中の入口の batch() に渡せない
void org.batch([orgStatement, commonStatement]);
// @ts-expect-error 組織の中の文を共通の入口で実行できない
void common.run(orgStatement);
// @ts-expect-error 共通の文を組織の中の入口で実行できない
void org.rows(commonStatement);

// 文は入口が作ったものだけが通る。形だけのオブジェクトと、付け替えた文は型の検査で落ちる
// @ts-expect-error 形だけのオブジェクトは文にならない
void common.run({ scope: 'common' });
// @ts-expect-error 付け替えた文は文にならない
void common.run({ ...commonStatement, scope: 'common' });
// @ts-expect-error 空のオブジェクトは文にならない
const forgedStatement: Statement<'common'> = {};
void forgedStatement;

// 書き込みの文（RETURNING の無い INSERT、UPDATE、DELETE）は行を持たず、rows と first に渡せない。結果は changes で見る
const insertStatement = common.statement((q) =>
  q.insertInto('accounts').values({ id: 'x', created_at: 'x', updated_at: 'x' }),
);
const updateStatement = common.statement((q) => q.updateTable('accounts').set({ updated_at: 'x' }));
const deleteStatement = common.statement((q) => q.deleteFrom('accounts'));
// @ts-expect-error INSERT は行を返さない
void common.rows(insertStatement);
// @ts-expect-error UPDATE は行を返さない
void common.first(updateStatement);
// @ts-expect-error DELETE は行を返さない
void common.rows(deleteStatement);
void common.run(insertStatement).then((result) => result.changes);
void common.batch([insertStatement, updateStatement, deleteStatement, commonStatement]);
// RETURNING を付ければ行を読める
const returning = common.statement((q) =>
  q.insertInto('accounts').values({ id: 'x', created_at: 'x', updated_at: 'x' }).returning('id'),
);
void common.rows(returning).then((rows) => rows[0]?.id satisfies string | undefined);

// 組織の中の入口は、確かめた組織の ID を読み取り専用で持つ
org.organizationId satisfies string;
// @ts-expect-error 読み取り専用
org.organizationId = 'x';

// 組織を確かめた結果が無いと、組織の中の入口は作れない
// @ts-expect-error 組織を確かめた結果が要る
orgDb(env);
// @ts-expect-error 同じ形のオブジェクトを書いても、確かめた結果にならない
orgDb(env, { organizationId: 'x' });
// @ts-expect-error ID の文字列では作れない
orgDb(env, 'x');
