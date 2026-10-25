import { z } from 'zod';

// ストーリーのダイアログが出す項目。作る操作と変える操作が、書いた後の値として返す
export const storyDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  acceptance_criteria_md: z.string().nullable(),
  body_md: z.string().nullable(),
  due_on: z.string().nullable(),
  link_url: z.string().nullable(),
});

export type StoryDetail = z.output<typeof storyDetailSchema>;
