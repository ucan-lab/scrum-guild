import type { PageLoad } from './$types';

// 組織の管理の画面が使う値。管理者かどうかの判定だけを持つ（管理者でなければ「見つからない」と同じ扱いにする）。
// 節のデータは、節の部品（src/lib/components/admin/）が自分で読む
export const load: PageLoad = async ({ parent }) => {
  const { organization } = await parent();
  return { forbidden: organization === null || !organization.me.is_admin };
};
