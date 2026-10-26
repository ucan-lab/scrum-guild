import { z } from 'zod';
import { resolvedCategorySchema } from '../definition/definition.ts';

// ストーリーのダイアログが出す項目。作る操作と変える操作が、書いた後の値として返す
export const storyDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  acceptance_criteria_md: z.string().nullable(),
  body_md: z.string().nullable(),
  due_on: z.string().nullable(),
  link_url: z.string().nullable(),
  // 親のエピック。親のあるストーリーは区分を振れない（親から引き継ぐ）
  epic_id: z.string().nullable(),
  // 引き継ぎを解いた区分（親のエピック、ストーリー自身の順）。inherited は親から引き継いだもの
  category: resolvedCategorySchema.nullable(),
});

export type StoryDetail = z.output<typeof storyDetailSchema>;
