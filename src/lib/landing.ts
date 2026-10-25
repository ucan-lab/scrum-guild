// ログインの直後の行き先（docs/requirements.md の「組織と運用者」）。数えるのは入れる組織だけで、
// 届いた招待があれば組織の選択の画面を出す。入れる組織が無い運用者は運用の画面へ
export type Landing = { to: 'organization'; slug: string } | { to: 'operator' } | { to: 'select' };

export function landingFor(account: {
  organizations: readonly { slug: string }[];
  invitations: readonly unknown[];
  operator: boolean;
}): Landing {
  if (account.invitations.length > 0) return { to: 'select' };
  const [only, ...others] = account.organizations;
  if (only !== undefined && others.length === 0) return { to: 'organization', slug: only.slug };
  if (only === undefined && account.operator) return { to: 'operator' };
  return { to: 'select' };
}
