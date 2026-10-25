// 組織を確かめた結果。組織の中の入口（orgDb）はこの型を引数に取るので、組織を確かめずに組織の中の表は引けない。
// 作れるのは src/server/db/ の中だけ。入口のモジュール（index.ts）は型だけを出し、値（issue）は出さない。
// #private を持つクラスなので、同じ形のオブジェクトを書いても型の検査で通らず、キャストで通しても is() が実行時に止める。
//
// 組織を確かめる処理（リクエストの組織が存在し、停止しておらず、ログインした人が入れること）はここに書く。中身は #51。
// 確かめて通ったときだけ VerifiedOrganization.issue() を呼ぶ
export class VerifiedOrganization {
  readonly #verified = true;
  readonly organizationId: string;

  private constructor(organizationId: string) {
    this.organizationId = organizationId;
  }

  static issue(organizationId: string): VerifiedOrganization {
    return new VerifiedOrganization(organizationId);
  }

  static is(value: unknown): value is VerifiedOrganization {
    return typeof value === 'object' && value !== null && #verified in value;
  }
}
