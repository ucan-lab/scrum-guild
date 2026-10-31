// 利用規約とプライバシーポリシーの文面（Markdown）と版。画面（/terms、/privacy）が読む。
// 文面は人が読んで直すので、コードに埋めずに Markdown のファイルに置き、vite の `?raw` で文字列として読み込む。
// 本文は `#` を条の見出しにし、末尾の行を「改定日: YYYY-MM-DD」にする。版は versions.ts の定数と一致させる
import privacySource from './privacy.md?raw';
import termsSource from './terms.md?raw';
import { PRIVACY_VERSION, TERMS_VERSION } from './versions.ts';

export type LegalKind = 'terms' | 'privacy';

export type LegalDocument = {
  // Markdown の本文
  source: string;
  // 版（改定日の YYYY-MM-DD）
  version: string;
};

export const legalDocuments: Record<LegalKind, LegalDocument> = {
  terms: { source: termsSource, version: TERMS_VERSION },
  privacy: { source: privacySource, version: PRIVACY_VERSION },
};

// 本文の末尾の行の「改定日: YYYY-MM-DD」から日付を取り出す。無ければ undefined
export function revisedDateOf(source: string): string | undefined {
  return /^改定日: (\d{4}-\d{2}-\d{2})$/.exec(source.trimEnd().split('\n').at(-1) ?? '')?.[1];
}
