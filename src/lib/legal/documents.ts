// 利用規約とプライバシーポリシーの文面（Markdown）と版。画面（/terms、/privacy）が読む。
// 文面は人が読んで直すので、コードに埋めずに Markdown のファイルに置き、vite の `?raw` で文字列として読み込む。
// 本文は `#` を条の見出しにし、末尾の行を「改定日: YYYY-MM-DD」にする。版は versions.ts の定数と一致させる。
// 末尾の改定日の行の前に置く `# 改定の履歴` の節（箇条書き。最初の行は制定）は、本文から分けて history に持つ。画面が本文の下に別の節として描く
import privacySource from './privacy.md?raw';
import termsSource from './terms.md?raw';
import { PRIVACY_VERSION, TERMS_VERSION } from './versions.ts';

export type LegalKind = 'terms' | 'privacy';

export type LegalDocument = {
  // Markdown の全文（末尾の「改定日: YYYY-MM-DD」の行を含む）
  source: string;
  // 画面に描く本文。末尾の改定日の行と「改定の履歴」の節を落としたもの（改定日は画面の別の場所に、版として出す）
  body: string;
  // 「改定の履歴」の節の Markdown（見出しの行を含む）。節が無い文面は空の文字列
  history: string;
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

// 「改定の履歴」の節の見出しの行
export const REVISION_HISTORY_HEADING = '# 改定の履歴';
// 本文（末尾の改定日の行を落としたもの）を、「改定の履歴」の節と、それ以外に分ける。
// 節は見出しの行から、次の `# ` の見出しの手前（無ければ末尾）まで。節が無ければ history は空の文字列
export function splitRevisionHistory(body: string): { body: string; history: string } {
  const lines = body.split('\n');
  const start = lines.indexOf(REVISION_HISTORY_HEADING);
  if (start === -1) return { body, history: '' };
  const next = lines.findIndex((line, i) => i > start && line.startsWith('# '));
  const end = next === -1 ? lines.length : next;
  return {
    body: [...lines.slice(0, start), ...lines.slice(end)].join('\n').trim(),
    history: lines.slice(start, end).join('\n').trim(),
  };
}

// 履歴の節の箇条書き（`- YYYY-MM-DD 何を改めたか`）のうち、最も新しい日付。日付の行が無ければ undefined。
// 並びは問わない（新しい順でも古い順でも同じ結果）。版を上げたのに履歴へ1行足し忘れたことを、テストが見つけるために使う
export function latestHistoryDate(history: string): string | undefined {
  const dates = [...history.matchAll(/^- (\d{4}-\d{2}-\d{2}) /gm)].map((match) => match[1] ?? '');
  return dates.toSorted().at(-1);
}

function document(source: string, version: string): LegalDocument {
  return { source, ...splitRevisionHistory(bodyOf(source)), version };
}

export const legalDocuments: Record<LegalKind, LegalDocument> = {
  terms: document(termsSource, TERMS_VERSION),
  privacy: document(privacySource, PRIVACY_VERSION),
};
