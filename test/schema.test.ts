// スキーマの CHECK と一意のうち、壊れると事故になるもの（docs/data-model.md）。
// 確かめたいのは SQL の制約そのものなので、Kysely の入口を通さず D1 の binding に直に書く
import { env } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';

const AT = '2026-10-20T00:00:00.000Z';
const CLAIM_EXPIRES_AT = '2026-11-03T00:00:00.000Z';

function id(): string {
  return crypto.randomUUID();
}

function run(sql: string, ...values: unknown[]) {
  return env.DB.prepare(sql)
    .bind(...values)
    .run();
}

async function organization(slug = `org-${id().slice(0, 8)}`): Promise<string> {
  const orgId = id();
  await run(
    `INSERT INTO organizations (id, slug, name, created_by_operator, created_at, updated_at) VALUES (?, ?, '組織', 'github:9000000000000001', ?, ?)`,
    orgId,
    slug,
    AT,
    AT,
  );
  return orgId;
}

type UserColumns = {
  loginProvider?: string;
  loginSubject?: string | null;
  loginEmail?: string | null;
  claimTokenHash?: string | null;
  claimExpiresAt?: string | null;
};

function insertUser(orgId: string, columns: UserColumns = {}) {
  const userId = id();
  return {
    userId,
    result: run(
      `INSERT INTO users (id, organization_id, login_provider, login_subject, login_email, claim_token_hash, claim_expires_at, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '人', ?, ?)`,
      userId,
      orgId,
      columns.loginProvider ?? 'github',
      columns.loginSubject === undefined ? id() : columns.loginSubject,
      columns.loginEmail ?? null,
      columns.claimTokenHash ?? null,
      columns.claimExpiresAt ?? null,
      AT,
      AT,
    ),
  };
}

async function user(orgId: string): Promise<string> {
  const { userId, result } = insertUser(orgId);
  await result;
  return userId;
}

async function workspace(): Promise<{ orgId: string; userId: string; workspaceId: string }> {
  const orgId = await organization();
  const userId = await user(orgId);
  const workspaceId = id();
  await run(
    `INSERT INTO workspaces (id, organization_id, name, timezone, created_by, created_at, updated_at) VALUES (?, ?, 'ワークスペース', 'Asia/Tokyo', ?, ?, ?)`,
    workspaceId,
    orgId,
    userId,
    AT,
    AT,
  );
  return { orgId, userId, workspaceId };
}

// テストファイルの中では前のテストの行が残るので、一意の列は呼ぶたびに新しい値にする
function googlePending() {
  return {
    loginProvider: 'google',
    loginSubject: null,
    loginEmail: 'mio.hoshino@example.com',
    claimTokenHash: (id() + id()).replaceAll('-', ''),
    claimExpiresAt: CLAIM_EXPIRES_AT,
  };
}

describe('外部キー', () => {
  test('D1 は外部キーを検査する', async () => {
    await expect(insertUser(id()).result).rejects.toThrow(/FOREIGN KEY/);
  });

  // 待っていた users の行を消すとき（Google の招待で同じ sub の行と統合する）、外部キーの検査が子の表を全件読まないこと
  test('users の行を消す文は、users を指すどの列も索引で引く', async () => {
    // D1 は pragma_foreign_key_list を表の列で結合すると断るので、表ごとに引く
    const { results: tables } = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_'`,
    ).all<{ name: string }>();
    const children: string[] = [];
    for (const { name } of tables) {
      const { results: keys } = await env.DB.prepare(`SELECT "table" AS parent FROM pragma_foreign_key_list(?)`)
        .bind(name)
        .all<{ parent: string }>();
      children.push(...keys.filter((key) => key.parent === 'users').map(() => name));
    }
    const { results: plan } = await env.DB.prepare(`EXPLAIN QUERY PLAN DELETE FROM users WHERE id = ?`)
      .bind(id())
      .all<{ detail: string }>();
    const details = plan.map((row) => row.detail);

    expect(details.filter((detail) => detail.startsWith('SCAN '))).toEqual([]);
    // その場で作る索引（AUTOMATIC）でなく、張った索引で引くこと
    expect(details.filter((detail) => !/^SEARCH \w+ USING (COVERING )?INDEX \w+ /.test(detail))).toEqual([]);
    // 外部キーの列ごとに1行ずつ SEARCH が出る。実行計画が検査を載せなくなったら、上の確かめが空振りするので数も見る
    const searched = details
      .map((detail) => /^SEARCH (\w+) /.exec(detail)?.[1])
      .filter((table) => table !== undefined && table !== 'users');
    expect(children.length).toBeGreaterThan(0);
    expect(searched.sort()).toEqual(children.sort());
  });

  // 外部キーの検査の索引が、担当の未完了のタスク（自分の今日、積載量）も引く。完了した行と消した行を読まないこと
  test('担当の未完了のタスクを引く文は、tasks_assignee_user の3列で絞る', async () => {
    const { results: plan } = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE assignee_user_id = ? AND deleted_at IS NULL AND completed_at IS NULL`,
    )
      .bind(id())
      .all<{ detail: string }>();
    const details = plan.map((row) => row.detail).join('\n');

    expect(details).toContain(
      'USING INDEX tasks_assignee_user (assignee_user_id=? AND deleted_at=? AND completed_at=?)',
    );
    expect(details).not.toMatch(/^SCAN tasks\b/m);
  });

  // 使わない索引も書くたびに更新され、D1 の書いた行数に数えられる。統計の無い空の表では計画が変わらないので、残っていないことを直に見る
  test('外部キーの検査の索引と重なる部分索引は残っていない', async () => {
    const { results } = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('memberships_user_current', 'tasks_assignee_open')`,
    ).all<{ name: string }>();

    expect(results).toEqual([]);
  });
});

// SQLite の通常の表では、PRIMARY KEY だけでは NULL を拒まない
describe('主キー', () => {
  test.each([
    ['省いた', `INSERT INTO accounts (created_at, updated_at) VALUES (?, ?)`],
    ['NULL を渡した', `INSERT INTO accounts (id, created_at, updated_at) VALUES (NULL, ?, ?)`],
  ])('ID を%sら当たる', async (_, sql) => {
    await expect(run(sql, AT, AT)).rejects.toThrow(/NOT NULL/);
  });
});

describe('セッションとログインの途中の状態', () => {
  async function account(): Promise<string> {
    const accountId = id();
    await run(`INSERT INTO accounts (id, created_at, updated_at) VALUES (?, ?, ?)`, accountId, AT, AT);
    return accountId;
  }

  function session(accountId: string, tokenHash: string) {
    return run(
      `INSERT INTO sessions (token_hash, account_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      tokenHash,
      accountId,
      AT,
      AT,
      AT,
    );
  }

  function oauthState(columns: { claimTokenHash?: string; returnTo?: string }) {
    return run(
      `INSERT INTO oauth_states (state, login_provider, code_verifier, claim_token_hash, return_to, expires_at) VALUES (?, 'google', 'v', ?, ?, ?)`,
      id(),
      columns.claimTokenHash ?? null,
      columns.returnTo ?? null,
      AT,
    );
  }

  test('token_hash は SHA-256 の小文字の16進64文字', async () => {
    const accountId = await account();
    await expect(session(accountId, (id() + id()).replaceAll('-', ''))).resolves.toBeTruthy();
  });

  test.each([
    ['ハッシュする前のトークン', 'dev-seed-admin-0000000000000000000000000000'],
    ['大文字の16進', 'A'.repeat(64)],
    ['63文字', 'a'.repeat(63)],
  ])('%sは当たる', async (_, tokenHash) => {
    await expect(session(await account(), tokenHash)).rejects.toThrow(/CHECK/);
    await expect(oauthState({ claimTokenHash: tokenHash })).rejects.toThrow(/CHECK/);
  });

  test.each(['/aoba', '/invite', '/'])('戻り先 %s は通る', async (returnTo) => {
    await expect(oauthState({ returnTo })).resolves.toBeTruthy();
  });

  test.each([
    '//evil.example',
    '/\\evil.example',
    'https://evil.example/',
    'aoba',
    '/\t/evil.example',
    '/\n/evil.example',
  ])('戻り先 %s は当たる', async (returnTo) => {
    await expect(oauthState({ returnTo })).rejects.toThrow(/CHECK/);
  });
});

describe('organizations.slug', () => {
  test.each(['ab', 'aoba', 'ab-1', '0a', 'a'.repeat(40)])('%s は通る', async (slug) => {
    await expect(organization(slug)).resolves.toBeTypeOf('string');
  });

  test.each(['a', 'a'.repeat(41), 'Aoba', '-ab', 'ab_c', 'ab c', 'あおば'])('%s は CHECK に当たる', async (slug) => {
    await expect(organization(slug)).rejects.toThrow(/CHECK/);
  });

  test('同じ slug は2つ作れない', async () => {
    await organization('same-slug');
    await expect(organization('same-slug')).rejects.toThrow(/UNIQUE/);
  });
});

// users と invitations は同じ3つの CHECK を持つ
describe.each(['users', 'invitations'] as const)('%s の待つ列', (table) => {
  async function insert(columns: UserColumns) {
    if (table === 'users') return insertUser(await organization(), columns).result;
    const { userId, workspaceId } = await workspace();
    return run(
      `INSERT INTO invitations (id, workspace_id, login_provider, login_subject, login_email, claim_token_hash, claim_expires_at, login_name, role, invited_by, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '人', 'member', ?, 'pending', ?)`,
      id(),
      workspaceId,
      columns.loginProvider ?? 'github',
      columns.loginSubject === undefined ? id() : columns.loginSubject,
      columns.loginEmail ?? null,
      columns.claimTokenHash ?? null,
      columns.claimExpiresAt ?? null,
      userId,
      AT,
    );
  }

  test('Google でメールアドレスと招待の URL の秘密で待つ行は入る', async () => {
    await expect(insert(googlePending())).resolves.toBeTruthy();
  });

  // 待つ列をすべて空にして、1つ目の CHECK だけが働く形にする
  test('待つ列が無いのに login_subject も空なら当たる', async () => {
    await expect(insert({ loginSubject: null })).rejects.toThrow(/CHECK/);
  });

  test('login_subject と login_email の両方が空なら当たる', async () => {
    await expect(insert({ ...googlePending(), loginEmail: null })).rejects.toThrow(/CHECK/);
  });

  test('login_subject と login_email の両方が入っていれば当たる', async () => {
    await expect(insert({ ...googlePending(), loginSubject: '1234567890' })).rejects.toThrow(/CHECK/);
  });

  test.each([
    ['claim_token_hash', { claimTokenHash: null }],
    ['claim_expires_at', { claimExpiresAt: null }],
  ])('%s が欠けたら当たる', async (_, missing) => {
    await expect(insert({ ...googlePending(), ...missing })).rejects.toThrow(/CHECK/);
  });

  test('login_email は google の行だけ', async () => {
    await expect(insert({ ...googlePending(), loginProvider: 'github' })).rejects.toThrow(/CHECK/);
  });

  test.each(['Mio.Hoshino@example.com', ' mio.hoshino@example.com'])(
    'そろえていないメールアドレス（%j）は当たる',
    async (loginEmail) => {
      await expect(insert({ ...googlePending(), loginEmail })).rejects.toThrow(/CHECK/);
    },
  );
});

describe('users の一意', () => {
  test('同じ組織に同じログインの ID の行は2つ作れない', async () => {
    const orgId = await organization();
    await insertUser(orgId, { loginSubject: '1000101' }).result;
    await expect(insertUser(orgId, { loginSubject: '1000101' }).result).rejects.toThrow(/UNIQUE/);
  });

  test('別の組織なら同じログインの ID でも作れる', async () => {
    await insertUser(await organization(), { loginSubject: '1000101' }).result;
    await expect(insertUser(await organization(), { loginSubject: '1000101' }).result).resolves.toBeTruthy();
  });

  test('login_subject が空の待つ行は同じ組織に2つあってよい', async () => {
    const orgId = await organization();
    await insertUser(orgId, googlePending()).result;
    await expect(insertUser(orgId, googlePending()).result).resolves.toBeTruthy();
  });

  test('同じアカウントは同じ組織に1行だけ', async () => {
    const orgId = await organization();
    const accountId = id();
    await run(`INSERT INTO accounts (id, created_at, updated_at) VALUES (?, ?, ?)`, accountId, AT, AT);
    const withAccount = (loginProvider: string) =>
      run(
        `INSERT INTO users (id, organization_id, account_id, login_provider, login_subject, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '人', ?, ?)`,
        id(),
        orgId,
        accountId,
        loginProvider,
        id(),
        AT,
        AT,
      );
    await withAccount('github');
    await expect(withAccount('google')).rejects.toThrow(/UNIQUE/);
  });

  test('同じ claim_token_hash は2つ作れない', async () => {
    const orgId = await organization();
    const pending = googlePending();
    await insertUser(orgId, pending).result;
    await expect(insertUser(orgId, { ...pending, loginEmail: 'kotone@example.com' }).result).rejects.toThrow(/UNIQUE/);
  });
});

describe('invitations の承諾待ちの一意', () => {
  async function invite(workspaceId: string, invitedBy: string, status: string, columns: UserColumns) {
    return run(
      `INSERT INTO invitations (id, workspace_id, login_provider, login_subject, login_email, claim_token_hash, claim_expires_at, login_name, role, invited_by, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '人', 'member', ?, ?, ?)`,
      id(),
      workspaceId,
      columns.loginProvider ?? 'github',
      columns.loginSubject === undefined ? id() : columns.loginSubject,
      columns.loginEmail ?? null,
      columns.claimTokenHash ?? null,
      columns.claimExpiresAt ?? null,
      invitedBy,
      status,
      AT,
    );
  }

  test('同じ人への承諾待ちの招待は1つだけ', async () => {
    const { userId, workspaceId } = await workspace();
    await invite(workspaceId, userId, 'pending', { loginSubject: '1000102' });
    await expect(invite(workspaceId, userId, 'pending', { loginSubject: '1000102' })).rejects.toThrow(/UNIQUE/);
  });

  test('承諾待ちでなくなった招待があれば、もう一度招待できる', async () => {
    const { userId, workspaceId } = await workspace();
    await invite(workspaceId, userId, 'revoked', { loginSubject: '1000102' });
    await expect(invite(workspaceId, userId, 'pending', { loginSubject: '1000102' })).resolves.toBeTruthy();
  });

  test('同じメールアドレスへの承諾待ちの招待は1つだけ', async () => {
    const { userId, workspaceId } = await workspace();
    await invite(workspaceId, userId, 'pending', googlePending());
    await expect(invite(workspaceId, userId, 'pending', googlePending())).rejects.toThrow(/UNIQUE/);
  });

  test('status は決まった値だけ', async () => {
    const { userId, workspaceId } = await workspace();
    await expect(invite(workspaceId, userId, 'expired', {})).rejects.toThrow(/CHECK/);
  });
});

describe('memberships の今の所属', () => {
  async function join(workspaceId: string, userId: string, leftAt: string | null) {
    return run(
      `INSERT INTO memberships (id, workspace_id, user_id, role, joined_on, left_on, joined_at, left_at) VALUES (?, ?, ?, 'member', '2026-10-01', ?, ?, ?)`,
      id(),
      workspaceId,
      userId,
      leftAt ? '2026-10-10' : null,
      AT,
      leftAt,
    );
  }

  test('今の所属は1人1行', async () => {
    const { userId, workspaceId } = await workspace();
    await join(workspaceId, userId, null);
    await expect(join(workspaceId, userId, null)).rejects.toThrow(/UNIQUE/);
  });

  test('抜けた行があっても、戻った新しい行を作れる', async () => {
    const { userId, workspaceId } = await workspace();
    await join(workspaceId, userId, AT);
    await expect(join(workspaceId, userId, null)).resolves.toBeTruthy();
  });

  test.each([
    ['離脱日だけ入っている', '2026-10-10', null],
    ['離脱の日時だけ入っている', null, AT],
    ['離脱日が参加日より前', '2026-09-30', AT],
  ])('%s行は当たる', async (_, leftOn, leftAt) => {
    const { userId, workspaceId } = await workspace();
    await expect(
      run(
        `INSERT INTO memberships (id, workspace_id, user_id, role, joined_on, left_on, joined_at, left_at) VALUES (?, ?, ?, 'member', '2026-10-01', ?, ?, ?)`,
        id(),
        workspaceId,
        userId,
        leftOn,
        AT,
        leftAt,
      ),
    ).rejects.toThrow(/CHECK/);
  });
});

describe('board_columns', () => {
  async function column(workspaceId: string, name: string | null, isDone: number) {
    return run(
      `INSERT INTO board_columns (id, workspace_id, name, is_done, position, created_at, updated_at) VALUES (?, ?, ?, ?, 'a0', ?, ?)`,
      id(),
      workspaceId,
      name,
      isDone,
      AT,
      AT,
    );
  }

  test('完了の列はワークスペースに1つ', async () => {
    const { workspaceId } = await workspace();
    await column(workspaceId, null, 1);
    await expect(column(workspaceId, null, 1)).rejects.toThrow(/UNIQUE/);
  });

  test('完了でない列は名前が要る', async () => {
    const { workspaceId } = await workspace();
    await expect(column(workspaceId, null, 0)).rejects.toThrow(/CHECK/);
  });
});

describe('tasks', () => {
  type TaskColumns = {
    isImported?: number;
    tray?: string;
    linkUrl?: string | null;
    createdBy?: string | null;
    storyId?: string | null;
    sprintId?: string | null;
    columnId?: string | null;
  };

  async function setup() {
    const ws = await workspace();
    const columnId = id();
    await run(
      `INSERT INTO board_columns (id, workspace_id, name, position, created_at, updated_at) VALUES (?, ?, '出発前', 'a0', ?, ?)`,
      columnId,
      ws.workspaceId,
      AT,
      AT,
    );
    const sprintId = id();
    await run(
      `INSERT INTO sprints (id, workspace_id, start_on, end_on, status, created_at, updated_at) VALUES (?, ?, '2026-10-13', '2026-10-26', 'active', ?, ?)`,
      sprintId,
      ws.workspaceId,
      AT,
      AT,
    );
    const storyId = id();
    await run(
      `INSERT INTO stories (id, workspace_id, title, created_by, position, created_at, updated_at) VALUES (?, ?, 'ストーリー', ?, 'a0', ?, ?)`,
      storyId,
      ws.workspaceId,
      ws.userId,
      AT,
      AT,
    );
    const task = (columns: TaskColumns = {}) =>
      run(
        `INSERT INTO tasks (id, workspace_id, is_imported, tray, title, link_url, story_id, sprint_id, column_id, position, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'タスク', ?, ?, ?, ?, 'a0', ?, ?, ?)`,
        id(),
        ws.workspaceId,
        columns.isImported ?? 0,
        columns.tray ?? 'backlog',
        columns.linkUrl ?? null,
        columns.storyId ?? null,
        columns.sprintId ?? null,
        columns.columnId ?? null,
        columns.createdBy === undefined ? ws.userId : columns.createdBy,
        AT,
        AT,
      );
    return { ...ws, columnId, sprintId, storyId, task };
  }

  test('手で作ったタスクと取り込んだタスクの決まった形は入る', async () => {
    const { task, sprintId, columnId, storyId } = await setup();
    await expect(task({ sprintId, columnId, storyId, linkUrl: 'https://example.com/' })).resolves.toBeTruthy();
    await expect(task({ isImported: 1, tray: 'inbox', createdBy: null })).resolves.toBeTruthy();
  });

  test.each(['javascript:alert(1)', 'ftp://example.com/', 'example.com'])(
    'http と https 以外のリンク（%s）は当たる',
    async (linkUrl) => {
      const { task } = await setup();
      await expect(task({ linkUrl })).rejects.toThrow(/CHECK/);
    },
  );

  test('手で作ったタスクはバックログにしか置けない', async () => {
    const { task } = await setup();
    await expect(task({ tray: 'inbox' })).rejects.toThrow(/CHECK/);
  });

  test('取り込んだタスクはリンクを持たない', async () => {
    const { task } = await setup();
    await expect(task({ isImported: 1, linkUrl: 'https://example.com/', createdBy: null })).rejects.toThrow(/CHECK/);
  });

  test('手で作ったタスクは起票した人が要る', async () => {
    const { task } = await setup();
    await expect(task({ createdBy: null })).rejects.toThrow(/CHECK/);
  });

  test.each([
    ['スプリント', 'sprint'],
    ['親', 'story'],
  ] as const)('受信箱のタスクは%sを持たない', async (_, kind) => {
    const { task, sprintId, columnId, storyId } = await setup();
    const columns = kind === 'sprint' ? { sprintId, columnId } : { storyId };
    await expect(task({ isImported: 1, tray: 'inbox', createdBy: null, ...columns })).rejects.toThrow(/CHECK/);
  });

  test('スプリントに入っていれば列を持ち、列を持てばスプリントに入っている', async () => {
    const { task, sprintId, columnId } = await setup();
    await expect(task({ sprintId })).rejects.toThrow(/CHECK/);
    await expect(task({ columnId })).rejects.toThrow(/CHECK/);
  });
});

describe('sprints', () => {
  async function sprint(workspaceId: string, startOn: string, endOn: string, status = 'planned') {
    return run(
      `INSERT INTO sprints (id, workspace_id, start_on, end_on, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id(),
      workspaceId,
      startOn,
      endOn,
      status,
      AT,
      AT,
    );
  }

  test('進行中のスプリントはワークスペースに1つ', async () => {
    const { workspaceId } = await workspace();
    await sprint(workspaceId, '2026-10-13', '2026-10-26', 'active');
    await expect(sprint(workspaceId, '2026-10-27', '2026-11-09', 'active')).rejects.toThrow(/UNIQUE/);
  });

  test.each([
    ['2026-10-13', '2026-10-13'],
    ['2026-10-01', '2026-10-28'],
  ])('%s〜%s は長さの範囲に入る', async (startOn, endOn) => {
    const { workspaceId } = await workspace();
    await expect(sprint(workspaceId, startOn, endOn)).resolves.toBeTruthy();
  });

  test.each([
    ['2026-10-01', '2026-10-29'],
    ['2026-10-13', '2026-10-12'],
  ])('%s〜%s は長さの CHECK に当たる', async (startOn, endOn) => {
    const { workspaceId } = await workspace();
    await expect(sprint(workspaceId, startOn, endOn)).rejects.toThrow(/CHECK/);
  });

  test('日付の形でなければ当たる', async () => {
    const { workspaceId } = await workspace();
    await expect(sprint(workspaceId, '2026/10/13', '2026-10-26')).rejects.toThrow(/CHECK/);
  });
});

// date() は形の崩れた値に NULL を返すので、= で比べると CHECK が NULL になって通ってしまう。IS で比べている
describe('月の形', () => {
  test.each([
    ['2026-10', true],
    ['2026-13', false],
    ['2026-1', false],
    ['202610', false],
  ])('%s', async (month, ok) => {
    const { workspaceId } = await workspace();
    const insert = run(
      `INSERT INTO workspace_point_rates (workspace_id, effective_month, hours_per_point, created_at) VALUES (?, ?, 4, ?)`,
      workspaceId,
      month,
      AT,
    );
    await (ok ? expect(insert).resolves.toBeTruthy() : expect(insert).rejects.toThrow(/CHECK/));
  });
});

describe('organization_holidays', () => {
  async function holiday(orgId: string, userId: string, holidayOn: string | null, name: string | null = null) {
    return run(
      `INSERT INTO organization_holidays (organization_id, holiday_on, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)`,
      orgId,
      holidayOn,
      name,
      userId,
      AT,
    );
  }

  test('同じ組織の同じ日付は1行だけ。別の組織なら同じ日付を持てる', async () => {
    const { orgId, userId } = await workspace();
    const other = await workspace();
    await holiday(orgId, userId, '2026-11-03');
    await expect(holiday(orgId, userId, '2026-11-03')).rejects.toThrow(/UNIQUE|PRIMARY KEY/);
    await expect(holiday(other.orgId, other.userId, '2026-11-03')).resolves.toBeTruthy();
  });

  test.each([['2026/11/03'], ['2026-02-30'], ['2026-11-3'], ['1999-12-31'], ['2100-01-01']])(
    '日付 %s は CHECK に当たる',
    async (holidayOn) => {
      const { orgId, userId } = await workspace();
      await expect(holiday(orgId, userId, holidayOn)).rejects.toThrow(/CHECK/);
    },
  );

  test('2000-01-01 と 2099-12-31 は入る', async () => {
    const { orgId, userId } = await workspace();
    await expect(holiday(orgId, userId, '2000-01-01')).resolves.toBeTruthy();
    await expect(holiday(orgId, userId, '2099-12-31')).resolves.toBeTruthy();
  });

  test('日付は空にできない', async () => {
    const { orgId, userId } = await workspace();
    await expect(holiday(orgId, userId, null)).rejects.toThrow(/NOT NULL/);
  });

  test('名前は NULL か 1〜40 字。空の文字列は持たない。字数はコードポイントで数える', async () => {
    const { orgId, userId } = await workspace();
    await expect(holiday(orgId, userId, '2026-11-03', null)).resolves.toBeTruthy();
    await expect(holiday(orgId, userId, '2026-11-06', '')).rejects.toThrow(/CHECK/);
    await expect(holiday(orgId, userId, '2026-11-04', '🎌'.repeat(40))).resolves.toBeTruthy();
    await expect(holiday(orgId, userId, '2026-11-05', 'あ'.repeat(41))).rejects.toThrow(/CHECK/);
  });
});

describe('comments', () => {
  async function comment(columns: { body: string; deletedAt?: string | null; deletedBy?: 'self' | null }) {
    const { userId, workspaceId } = await workspace();
    const taskId = id();
    await run(
      `INSERT INTO tasks (id, workspace_id, is_imported, tray, title, position, created_by, created_at, updated_at) VALUES (?, ?, 0, 'backlog', 'タスク', 'a0', ?, ?, ?)`,
      taskId,
      workspaceId,
      userId,
      AT,
      AT,
    );
    return run(
      `INSERT INTO comments (id, workspace_id, task_id, author_user_id, body_md, deleted_at, deleted_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id(),
      workspaceId,
      taskId,
      userId,
      columns.body,
      columns.deletedAt ?? null,
      columns.deletedBy === 'self' ? userId : null,
      AT,
    );
  }

  test('本文は 10 万字まで。字数はコードポイントで数える', async () => {
    await expect(comment({ body: '😀'.repeat(100_000) })).resolves.toBeTruthy();
    await expect(comment({ body: 'あ'.repeat(100_001) })).rejects.toThrow(/CHECK/);
  });

  test('消していないコメントの本文は空にできず、消したコメントの本文は空', async () => {
    await expect(comment({ body: '' })).rejects.toThrow(/CHECK/);
    await expect(comment({ body: '残った本文', deletedAt: AT, deletedBy: 'self' })).rejects.toThrow(/CHECK/);
    await expect(comment({ body: '', deletedAt: AT, deletedBy: 'self' })).resolves.toBeTruthy();
  });

  test('消した日時と消した人は、両方入るか両方空', async () => {
    await expect(comment({ body: '', deletedAt: AT, deletedBy: null })).rejects.toThrow(/CHECK/);
    await expect(comment({ body: '本文', deletedAt: null, deletedBy: 'self' })).rejects.toThrow(/CHECK/);
  });
});

describe('sprint_entries', () => {
  async function taskAndSprint() {
    const { userId, workspaceId } = await workspace();
    const taskId = id();
    const sprintId = id();
    await run(
      `INSERT INTO tasks (id, workspace_id, is_imported, tray, title, position, created_by, created_at, updated_at) VALUES (?, ?, 0, 'backlog', 'タスク', 'a0', ?, ?, ?)`,
      taskId,
      workspaceId,
      userId,
      AT,
      AT,
    );
    await run(
      `INSERT INTO sprints (id, workspace_id, start_on, end_on, status, created_at, updated_at) VALUES (?, ?, '2026-11-02', '2026-11-15', 'planned', ?, ?)`,
      sprintId,
      workspaceId,
      AT,
      AT,
    );
    const entry = (endedAt: string | null, outcome: string | null) =>
      run(
        `INSERT INTO sprint_entries (id, workspace_id, sprint_id, task_id, added_at, added_by, ended_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id(),
        workspaceId,
        sprintId,
        taskId,
        AT,
        userId,
        endedAt,
        outcome,
      );
    return { entry };
  }

  test('1つのタスクが入っている行（ended_at が空）は1つ。出た行はいくつでも持てる', async () => {
    const { entry } = await taskAndSprint();
    await expect(entry(AT, 'removed')).resolves.toBeTruthy();
    await expect(entry(AT, 'removed')).resolves.toBeTruthy();
    await expect(entry(null, null)).resolves.toBeTruthy();
    await expect(entry(null, null)).rejects.toThrow(/UNIQUE/);
  });

  test('出た日時と出方は、両方入るか両方空。出方は completed、carried_over、removed のどれか', async () => {
    const { entry } = await taskAndSprint();
    await expect(entry(AT, null)).rejects.toThrow(/CHECK/);
    await expect(entry(null, 'removed')).rejects.toThrow(/CHECK/);
    await expect(entry(AT, 'deleted')).rejects.toThrow(/CHECK/);
    await expect(entry(AT, 'completed')).resolves.toBeTruthy();
    await expect(entry(AT, 'carried_over')).resolves.toBeTruthy();
  });
});

describe('xp_grants.dedupe_key', () => {
  test('同じキーの付与は2つ作れない', async () => {
    const { userId, workspaceId } = await workspace();
    const grant = () =>
      run(
        `INSERT INTO xp_grants (id, workspace_id, user_id, action, amount, dedupe_key, confirmed_at) VALUES (?, ?, ?, 'task_completed', 10, ?, ?)`,
        id(),
        workspaceId,
        userId,
        'task_completed:019a0000-0000-7000-8000-000000000901',
        AT,
      );
    await grant();
    await expect(grant()).rejects.toThrow(/UNIQUE/);
  });
});
