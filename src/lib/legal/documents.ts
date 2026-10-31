// 利用規約とプライバシーポリシーの文面（Markdown）と版。画面（/terms、/privacy）が読む。
// 文面は人が読んで直すので、コードに埋めずに Markdown のファイルに置き、vite の `?raw` で文字列として読み込む。
// 本文は `#` を条の見出しにし、末尾の行を「改定日: YYYY-MM-DD」にする。版は versions.ts の定数と一致させる
import privacySource from './privacy.md?raw';
import termsSource from './terms.md?raw';
import { PRIVACY_VERSION, TERMS_VERSION } from './versions.ts';

export type LegalKind = 'terms' | 'privacy';

export type LegalDocument = {
  // Markdown の全文（末尾の「改定日: YYYY-MM-DD」の行を含む）
  source: string;
  // 画面に描く本文。末尾の改定日の行を落としたもの（改定日は画面の別の場所に、版として出す）
  body: string;
  // 版（改定日の YYYY-MM-DD）
  version: string;
};

// 末尾の行の「改定日: YYYY-MM-DD」から日付を取り出す。無ければ undefined
export function revisedDateOf(source: string): string | undefined {
  return /^改定日: (\d{4}-\d{2}-\d{2})$/.exec(source.trimEnd().split('\n').at(-1) ?? '')?.[1];
}

// 末尾の改定日の行（とその前の空行）を落とした本文。末尾が改定日の行でなければそのまま返す
export function bodyOf(source: string): string {
  if (revisedDateOf(source) === undefined) return source;
  return source.trimEnd().split('\n').slice(0, -1).join('\n').trimEnd();
}

function document(source: string, version: string): LegalDocument {
  return { source, body: bodyOf(source), version };
}

export const legalDocuments: Record<LegalKind, LegalDocument> = {
  terms: document(termsSource, TERMS_VERSION),
  privacy: document(privacySource, PRIVACY_VERSION),
};
