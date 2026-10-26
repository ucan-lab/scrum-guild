import { z } from 'zod';

// エピックのダイアログが出す項目。作る操作と変える操作が、書いた後の値として返す
export const epicDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  body_md: z.string().nullable(),
  due_on: z.string().nullable(),
  link_url: z.string().nullable(),
  // 振った区分。配下のストーリーとタスクが引き継ぐ。無ければ null
  category_id: z.string().nullable(),
});

export type EpicDetail = z.output<typeof epicDetailSchema>;
