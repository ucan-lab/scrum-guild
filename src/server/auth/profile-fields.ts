// ログインの手段が返すプロフィールの項目（account_logins.display_name とアバター）を整える。GitHub と Google で同じ規則を使う
import { stripHiddenCharacters } from '../../shared/hidden-characters.ts';

const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_AVATAR_URL_LENGTH = 500;

// 手段の側の名前。名前で断る文字（制御文字、区切り、向きを変える文字、見えない空白や演算子。shared/hidden-characters.ts）は
// 取り除く。似せたアカウントを指名させるのに使われうるため。絵文字の結合（ZWJ）などは残す。
// 取り除いて空になる、空白だけ、文字列でない、のどれかなら null。長さはコードポイントで切る（絵文字を途中で割らない）
export function displayNameOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = stripHiddenCharacters(value).trim();
  return cleaned === '' ? null : [...cleaned].slice(0, MAX_DISPLAY_NAME_LENGTH).join('');
}

// アバターは手段のアバターのホスト（host）の https だけ。ほかのホストの画像を、画面から読ませない。
// CSP の img-src はホストとポートで照合するので、ポートの指定とユーザー情報（user:pass@）が付いたものも通さない
export function avatarUrlOf(value: unknown, host: string): string | null {
  if (typeof value !== 'string' || value.length > MAX_AVATAR_URL_LENGTH) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === host &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
      ? value
      : null;
  } catch {
    return null;
  }
}
