import type { LegalKind } from './legal/documents.ts';

// 同意の画面（/consent）が「改めました」と案内する文書の判定。consent-status の出力のうち、判定に使う分だけを受ける
export type ConsentRevisionInput = {
  terms_version: string;
  privacy_version: string;
  latest: { terms_version: string; privacy_version: string } | null;
};

export type RevisedDocument = {
  kind: LegalKind;
  // 今の版（改定日）。YYYY-MM-DD
  version: string;
};

// 前の同意と版が違う文書（利用規約、プライバシーポリシー）を、今の版つきで返す。
// 初めて同意する人（latest が null）は「改めた」のでなく初めてなので、空を返す。
// 今の版に同意済み（current）の人にも案内は要らないので、空を返す
export function revisedDocuments(status: ConsentRevisionInput & { current: boolean }): RevisedDocument[] {
  if (status.current || status.latest === null) return [];
  const revised: RevisedDocument[] = [];
  if (status.latest.terms_version !== status.terms_version) {
    revised.push({ kind: 'terms', version: status.terms_version });
  }
  if (status.latest.privacy_version !== status.privacy_version) {
    revised.push({ kind: 'privacy', version: status.privacy_version });
  }
  return revised;
}
