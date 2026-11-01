// 利用規約とプライバシーポリシーの版。文面を改めた日（改定日）の `YYYY-MM-DD` を、版として使う。
// 文面（terms.md、privacy.md）の末尾の「改定日: YYYY-MM-DD」と必ず一致させる（documents.test.ts が照合する）。
// 文面を直したら、この日付も同じ日に直す。
// Markdown を読み込まない（`?raw` を使わない）ので、Worker からも同じ版を読める（同意を記録するときに、この版を残す）

export const TERMS_VERSION = '2026-11-02';
export const PRIVACY_VERSION = '2026-10-31';

export const LEGAL_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
