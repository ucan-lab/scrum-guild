// ログインの手段の共通の型（docs/requirements.md の「メンバーと権限」）。型が持つのは、
// 本人の確認（認可の URL と、戻ってきた code の確かめ）、手段の中の不変の ID と表示名とアバターの取得、招待する人の指し方。
// 人は手段（provider）と手段の中の ID（subject）の組で見分け、アカウントは特定の手段に依存させない。
// 手段の実装は github.ts と google.ts
//
// 人が差分を読む領域（docs/development.md の「マージの判定」）

export type LoginProfile = {
  // 手段の中の不変の ID。受け取った文字列のまま持つ（GitHub ではユーザー ID を10進の文字列で。Google の sub も数値に直さない）
  subject: string;
  // account_logins.login_name。ログインのたびに書き直す表示用の名前
  loginName: string;
  // account_logins.display_name。手段の側の名前。無ければ null
  displayName: string | null;
  avatarUrl: string | null;
  // 手段が確かめたメールアドレス（Google の ID トークンで email_verified が真偽値の true のときだけ。そろえる前の値）。
  // メールアドレスで待つ指名と招待に結ぶときにだけ使う。account_logins にもログにも出さない。持たない手段と確かめられなかったときは null か省略
  verifiedEmail?: string | null;
};

// 招待する人の解決の結果。displayName とアバターは、運用者や招待する人が、指した相手を確かめるために見せる
export type ResolvedInvitee = {
  subject: string;
  loginName: string;
  displayName: string | null;
  avatarUrl: string | null;
};

// not_found: 当たる人がいない。not_a_user: 当たったが個人のアカウントではない（GitHub の組織など。ログインできない）
export type InviteeResolution =
  { kind: 'found'; invitee: ResolvedInvitee } | { kind: 'not_found' } | { kind: 'not_a_user' };

// nonce は usesNonce の手段にだけ入る（それ以外は null）
export type AuthorizationRequest = { state: string; codeChallenge: string; redirectUri: string; nonce: string | null };
export type VerificationRequest = { code: string; codeVerifier: string; redirectUri: string; nonce: string | null };

// rejected: code が使えない（使い済み、期限切れ、違う）。人がもう一度ログインすれば通る。
// unavailable: 手段の側に届かない、応答が想定と違う、こちらの設定が合わない。人がやり直しても通らないことがある
export type LoginMethodFailure = 'rejected' | 'unavailable';

// message は固定の文だけにする。code、トークン、応答の本文を入れない（ログに出るため）
export class LoginMethodError extends Error {
  readonly failure: LoginMethodFailure;

  constructor(failure: LoginMethodFailure, message: string) {
    super(message);
    this.name = 'LoginMethodError';
    this.failure = failure;
  }
}

export interface LoginMethod {
  readonly provider: string;
  // true の手段は、開始で nonce を作って state の行に入れ、認可の URL と verify に渡す（ID トークンに入れて返させる手段）
  readonly usesNonce: boolean;
  // 手段の認可の URL
  authorizeUrl(request: AuthorizationRequest): string;
  // 戻ってきた code を確かめ、手段の中の ID と表示名とアバターを返す。確かめられなければ LoginMethodError を投げる
  verify(request: VerificationRequest): Promise<LoginProfile>;
}

// 招待する人の指し方を持つ手段。GitHub はユーザー名を、招待のときにユーザー ID に解決する。
// 手段の側にメールアドレスから ID を引く口が無い手段（Google）は持たない。
// 当たる人がいない、個人のアカウントでない、は結果で分けて返す。届かないときは LoginMethodError（unavailable）を投げる
export interface InviteeResolver {
  resolveInvitee(reference: string): Promise<InviteeResolution>;
}
