import { z } from 'zod';
import { conflictReasonOf } from '../conflict-reason.ts';

// 区分、リポジトリ、決まった欄の定義を 409 の conflict で断った理由（details.reason）。
// duplicate_name は同じワークスペースに削除していない同じ名前がある、limit は数が上限（区分とリポジトリは 50、決まった欄は 10）に達している
export const definitionConflictReasons = ['duplicate_name', 'limit'] as const;
export type DefinitionConflictReason = (typeof definitionConflictReasons)[number];

export function definitionConflictReasonOf(details: unknown): DefinitionConflictReason | undefined {
  return conflictReasonOf(details, definitionConflictReasons);
}

// エピック、ストーリー、タスクに区分を振るときに 409 の conflict で断った理由。has_parent は親のあるもの（区分は親から引き継ぐ）
export const categoryConflictReasons = ['has_parent'] as const;
export type CategoryConflictReason = (typeof categoryConflictReasons)[number];

export function categoryConflictReasonOf(details: unknown): CategoryConflictReason | undefined {
  return conflictReasonOf(details, categoryConflictReasons);
}

// 区分の定義。is_billed_monthly は月ごとに計上する（完了の記録に計上月を持つ）
export const categorySchema = z.object({ id: z.string(), name: z.string(), is_billed_monthly: z.boolean() });
export type Category = z.output<typeof categorySchema>;

// リポジトリの定義。取り込み元の入る先との結び付け（provider、source_container_id）は #67 で足す
export const repositorySchema = z.object({ id: z.string(), name: z.string() });
export type Repository = z.output<typeof repositorySchema>;

// タスクの決まった欄の定義。名前はリーダーが付けたまま出す（辞書を通さない）
export const detailFieldSchema = z.object({ id: z.string(), name: z.string() });
export type DetailField = z.output<typeof detailFieldSchema>;

// 行や詳細に出す、振った区分とリポジトリの ID と名前
export const definitionRefSchema = z.object({ id: z.string(), name: z.string() });
export type DefinitionRef = z.output<typeof definitionRefSchema>;

// 引き継ぎを解いた区分。inherited は親（エピックかストーリー）から引き継いだもの
export const resolvedCategorySchema = definitionRefSchema.extend({ inherited: z.boolean() });
export type ResolvedCategory = z.output<typeof resolvedCategorySchema>;
