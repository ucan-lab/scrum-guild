import { describe, expect, test } from 'vitest';
import { revisedDocuments } from './consent-revision.ts';

const NOW = { terms_version: '2026-11-15', privacy_version: '2026-10-31' };
const OLD = '2026-10-01';

function status(latest: { terms_version: string; privacy_version: string } | null, current = false) {
  return { ...NOW, latest, current };
}

describe('revisedDocuments', () => {
  test('初めて同意する人（latest が null）には、改めた文書を挙げない', () => {
    expect(revisedDocuments(status(null))).toEqual([]);
  });

  test('今の版に同意済み（current）の人には挙げない', () => {
    expect(
      revisedDocuments(status({ terms_version: NOW.terms_version, privacy_version: NOW.privacy_version }, true)),
    ).toEqual([]);
    // current が真なら、latest の版が食い違っていても案内しない（API の判定を正とする）
    expect(revisedDocuments(status({ terms_version: OLD, privacy_version: OLD }, true))).toEqual([]);
  });

  test('両方を改めたときは、利用規約とプライバシーポリシーの順に、今の版をつけて挙げる', () => {
    expect(revisedDocuments(status({ terms_version: OLD, privacy_version: OLD }))).toEqual([
      { kind: 'terms', version: NOW.terms_version },
      { kind: 'privacy', version: NOW.privacy_version },
    ]);
  });

  test('利用規約だけを改めたときは、利用規約だけを挙げる', () => {
    expect(revisedDocuments(status({ terms_version: OLD, privacy_version: NOW.privacy_version }))).toEqual([
      { kind: 'terms', version: NOW.terms_version },
    ]);
  });

  test('プライバシーポリシーだけを改めたときは、プライバシーポリシーだけを挙げる', () => {
    expect(revisedDocuments(status({ terms_version: NOW.terms_version, privacy_version: OLD }))).toEqual([
      { kind: 'privacy', version: NOW.privacy_version },
    ]);
  });

  test('前の同意が今の版より新しい（巻き戻した）ときも、版が違う文書を挙げる', () => {
    expect(revisedDocuments(status({ terms_version: '2027-01-01', privacy_version: NOW.privacy_version }))).toEqual([
      { kind: 'terms', version: NOW.terms_version },
    ]);
  });

  test('どの文書も版が同じなら、current が偽でも挙げない', () => {
    expect(
      revisedDocuments(status({ terms_version: NOW.terms_version, privacy_version: NOW.privacy_version })),
    ).toEqual([]);
  });
});
