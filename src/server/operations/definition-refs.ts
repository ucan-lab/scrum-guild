// エピック、ストーリー、タスクに区分とリポジトリを振る書き込み（作成と変更）が共通で使う、振れる行の条件と読み取り
import type { CategoryConflictReason, DefinitionRef } from '../../shared/operations/definition/definition.ts';
import type { OrganizationDb, OrganizationTables, QueryCreator } from '../db/index.ts';
import { ApiError } from '../errors.ts';

type From = Pick<QueryCreator<OrganizationTables>, 'selectFrom'>;

// 振れる区分。同じワークスペースの削除していないもの。読む文と書く文の条件（EXISTS）の両方に使う
export function categoryRow(from: From, workspaceId: string, categoryId: string) {
  return from
    .selectFrom('categories')
    .where('categories.id', '=', categoryId)
    .where('categories.workspace_id', '=', workspaceId)
    .where('categories.deleted_at', 'is', null);
}

// 振れるリポジトリ。同じワークスペースの削除していないもの
export function repositoryRow(from: From, workspaceId: string, repositoryId: string) {
  return from
    .selectFrom('repositories')
    .where('repositories.id', '=', repositoryId)
    .where('repositories.workspace_id', '=', workspaceId)
    .where('repositories.deleted_at', 'is', null);
}

// 振る区分を読む。無い（別の組織、別のワークスペース、削除済みを含む）ときは 404
export async function readCategoryRef(
  db: OrganizationDb,
  workspaceId: string,
  categoryId: string,
): Promise<DefinitionRef> {
  const row = await db.first(
    db.statement((q) => categoryRow(q, workspaceId, categoryId).select(['categories.id', 'categories.name'])),
  );
  if (row === undefined) throw new ApiError(404, 'not_found');
  return row;
}

// 振るリポジトリを読む。無いときは 404
export async function readRepositoryRef(
  db: OrganizationDb,
  workspaceId: string,
  repositoryId: string,
): Promise<DefinitionRef> {
  const row = await db.first(
    db.statement((q) => repositoryRow(q, workspaceId, repositoryId).select(['repositories.id', 'repositories.name'])),
  );
  if (row === undefined) throw new ApiError(404, 'not_found');
  return row;
}

// 区分を振れないことを 409 の conflict で断る。理由は details.reason に載せる
export function categoryConflict(reason: CategoryConflictReason): ApiError {
  return new ApiError(409, 'conflict', { reason });
}

// 履歴に残す区分とリポジトリの値。ID があれば、名前が読めなくても（競合で消えた）落とさず空の名前で残す
export function refOf(id: string | null, name: string | null | undefined): DefinitionRef | null {
  return id === null ? null : { id, name: name ?? '' };
}
