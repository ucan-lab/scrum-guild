// 自分の組織を作るダイアログ（CreateMyOrganizationDialog.svelte）の、入力の確かめと失敗の振り分け。
// 画面の状態を持たない関数だけを置く（$app を読まないので、node で試せる）
import type { ApiResult } from './api.ts';
import { hasHiddenCharacter, ORGANIZATION_NAME_MAX_LENGTH } from '../shared/operations/operator/index.ts';
import { createMyOrganizationConflictReasonOf } from '../shared/operations/organization/index.ts';
import { slugProblem } from '../shared/organization-slug.ts';
import type { DictionaryKey } from '../shared/vocabulary.ts';

export type CreateMyOrganizationField = 'slug' | 'name' | 'form';
export type CreateMyOrganizationFailure = { field: CreateMyOrganizationField; key: DictionaryKey };
type FailedResult = Extract<ApiResult<unknown>, { ok: false }>;
type Problem = { path?: string; code?: string };

// 送る前の確かめ。サーバーも同じ確かめをする（ここは入力の誤りをすぐ知らせるため）。slug と名前は trim してから見る
export function validateCreateMyOrganization(input: {
  slug: string;
  name: string;
}): CreateMyOrganizationFailure | null {
  const slug = input.slug.trim();
  if (slug === '') return { field: 'slug', key: 'createMyOrganizationSlugRequired' };
  const problem = slugProblem(slug);
  if (problem !== undefined) {
    return {
      field: 'slug',
      key: problem === 'format' ? 'createMyOrganizationSlugFormat' : 'createMyOrganizationSlugReserved',
    };
  }
  const name = input.name.trim();
  if (name === '') return { field: 'name', key: 'createMyOrganizationNameRequired' };
  if (name.length > ORGANIZATION_NAME_MAX_LENGTH) return { field: 'name', key: 'createMyOrganizationNameLong' };
  if (hasHiddenCharacter(name)) return { field: 'name', key: 'createMyOrganizationNameInvalid' };
  return null;
}

function problemsOf(result: FailedResult): Problem[] {
  const details = result.error?.details;
  if (!Array.isArray(details)) return [];
  return details.flatMap((item: unknown): Problem[] => {
    if (typeof item !== 'object' || item === null) return [];
    return [
      {
        path: 'path' in item && typeof item.path === 'string' ? item.path : undefined,
        code: 'code' in item && typeof item.code === 'string' ? item.code : undefined,
      },
    ];
  });
}

// 失敗を、どの欄にどの文言を出すかに写す。400 の details の path が欄の名前（slug、name）で、欄の近くに理由を出す。
// ログインが切れた（401）と、規約に同意していない（403 の terms_required）は、呼び出し側が画面ごと移すので、ここへ渡さない
export function createMyOrganizationFailure(result: FailedResult): CreateMyOrganizationFailure {
  const reason = createMyOrganizationConflictReasonOf(result.error?.details);
  if (reason === 'slug_taken') return { field: 'slug', key: 'createMyOrganizationSlugTaken' };
  if (reason === 'trial_limit') return { field: 'form', key: 'createMyOrganizationTrialLimit' };
  if (result.status === 400) {
    const problems = problemsOf(result);
    const slugCode = problems.find((problem) => problem.path === 'slug')?.code;
    if (slugCode !== undefined) {
      return {
        field: 'slug',
        key: slugCode === 'slug_reserved' ? 'createMyOrganizationSlugReserved' : 'createMyOrganizationSlugFormat',
      };
    }
    if (problems.some((problem) => problem.path === 'name')) {
      return { field: 'name', key: 'createMyOrganizationNameInvalid' };
    }
    return { field: 'form', key: 'createMyOrganizationInvalid' };
  }
  if (result.status === 429) return { field: 'form', key: 'createMyOrganizationRateLimited' };
  return { field: 'form', key: 'createMyOrganizationFailed' };
}
