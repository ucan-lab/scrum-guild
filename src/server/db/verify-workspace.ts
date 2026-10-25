// ワークスペースを組織のものと確かめた結果。ワークスペースの下の操作の処理はこれを受け取り、
// 自分の文を workspace_id で絞る。作りは VerifiedOrganization と同じ（作る関数はモジュールの関数で、コンストラクターは札を要り、
// 作った値は WeakSet に登録して凍結する）。作れるのは src/server/db/ の中だけで、入口のモジュール（index.ts）は型だけを出す
const issueToken = Symbol('issue-workspace');
const issuedValues = new WeakSet<object>();

// その人のワークスペースでのロール。所属していない（管理者が所属外のワークスペースを操作する）ときは null
export type WorkspaceRole = 'leader' | 'member' | null;

export class VerifiedWorkspace {
  declare private readonly brand: true;
  readonly workspaceId: string;
  // 確かめた組織の ID。ワークスペースが属する組織
  readonly organizationId: string;
  readonly actorRole: WorkspaceRole;
  // 閉じたワークスペース（closed_at が入っている）。読み取り専用で、書き込みの操作は登録の関数が止める
  readonly closed: boolean;

  constructor(token: symbol, organizationId: string, workspaceId: string, actorRole: WorkspaceRole, closed: boolean) {
    if (token !== issueToken) throw new Error('確かめたワークスペースは、ワークスペースを確かめる処理だけが作る');
    this.organizationId = organizationId;
    this.workspaceId = workspaceId;
    this.actorRole = actorRole;
    this.closed = closed;
    Object.freeze(this);
  }

  static is(value: unknown): value is VerifiedWorkspace {
    return typeof value === 'object' && value !== null && issuedValues.has(value);
  }
}

export function issueVerifiedWorkspace(
  organizationId: string,
  workspaceId: string,
  actorRole: WorkspaceRole,
  closed: boolean,
): VerifiedWorkspace {
  const verified = new VerifiedWorkspace(issueToken, organizationId, workspaceId, actorRole, closed);
  issuedValues.add(verified);
  return verified;
}

// 処理に渡す直前の検査。型の検査をキャストで抜けた値（同じ形のオブジェクト）を実行時に止める
export function assertVerifiedWorkspace(value: unknown): asserts value is VerifiedWorkspace {
  if (!VerifiedWorkspace.is(value)) throw new Error('ワークスペースを確かめた結果ではない');
}
