// 組織を確かめた結果。組織の中の入口（orgDb）はこの型を引数に取るので、組織を確かめずに組織の中の表は引けない。
// 作れるのは src/server/db/ の中だけ。入口のモジュール（index.ts）は型だけを出し、値は出さない。
// 作る関数（issueVerifiedOrganization）はクラスの外のモジュールの関数で、手に入れた値からは辿れない。
// コンストラクターは作る関数だけが持つ札を要り、値の constructor から作り直せない。
// 型の上では private な印で、同じ形のオブジェクトは通らない。実行時には、作る関数が登録したものだけを is() が通す。
//
// 組織を確かめる処理（リクエストの組織が存在し、ログインした人が入れること。停止していないかは入口を渡すかどうかを決める）は enter-organization.ts。
// このほかに作るのは、組織の作成の関数（create-organization.ts。挿入した組織の ID だけ）と、運用者の履歴の関数
// （operator-change-log.ts。履歴を1行足すだけで、作った結果は関数の外へ出さない）。
// ワークスペースを組織のものと確かめた結果は verify-workspace.ts に、同じ作りで置く
const issueToken = Symbol('issue');
const issuedValues = new WeakSet<object>();

export class VerifiedOrganization {
  declare private readonly brand: true;
  readonly organizationId: string;

  constructor(token: symbol, organizationId: string) {
    if (token !== issueToken) throw new Error('組織を確かめた結果は、組織を確かめる処理だけが作る');
    this.organizationId = organizationId;
    Object.freeze(this);
  }

  static is(value: unknown): value is VerifiedOrganization {
    return typeof value === 'object' && value !== null && issuedValues.has(value);
  }
}

export function issueVerifiedOrganization(organizationId: string): VerifiedOrganization {
  const verified = new VerifiedOrganization(issueToken, organizationId);
  issuedValues.add(verified);
  return verified;
}
