// ログインの手段の共通の型（docs/requirements.md の「メンバーと権限」）。型が持つのは、
// 本人の確認（認可の URL と、戻ってきた code の確かめ）、手段の中の不変の ID と表示名とアバターの取得、招待する人の指し方。
// 人は手段（provider）と手段の中の ID（subject）の組で見分け、アカウントは特定の手段に依存させない。
// 手段の実装は github.ts。Google は #57 で同じ型に足す
//
// 人が差分を読む領域（docs/development.md の「マージの判定」）

export type LoginProfile = {
  // 手段の中の不変の ID。GitHub ではユーザー ID を10進の文字列で、受け取った文字列のまま持つ
  subject: string;
  // account_logins.login_name。ログインのたびに書き直す表示用の名前
  loginName: string;
  // account_logins.display_name。手段の側の名前。無ければ null
  displayName: string | null;
  avatarUrl: string | null;
};

export type ResolvedInvitee = { subject: string; loginName: string };

export type AuthorizationRequest = { state: string; codeChallenge: string; redirectUri: string };
export type VerificationRequest = { code: string; codeVerifier: string; redirectUri: string };

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
  // 手段の認可の URL
  authorizeUrl(request: AuthorizationRequest): string;
  // 戻ってきた code を確かめ、手段の中の ID と表示名とアバターを返す。確かめられなければ LoginMethodError を投げる
  verify(request: VerificationRequest): Promise<LoginProfile>;
  // 招待する人の指し方。GitHub はユーザー名を、招待のときにユーザー ID に解決する。当たる人がいなければ undefined
  resolveInvitee(reference: string): Promise<ResolvedInvitee | undefined>;
}
