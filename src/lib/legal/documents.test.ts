// 利用規約とプライバシーポリシーの文面（Markdown）と版の照合。文面は人が直すので、直し忘れ（末尾の改定日と版の食い違い）を止める
import { describe, expect, test } from 'vitest';
import { parseMarkdown, type MarkdownBlock, type MarkdownInline } from '../markdown.ts';
import { legalDocuments, revisedDateOf, type LegalKind } from './documents.ts';
import { LEGAL_VERSION_PATTERN, PRIVACY_VERSION, TERMS_VERSION } from './versions.ts';

const kinds: LegalKind[] = ['terms', 'privacy'];

function textOf(nodes: MarkdownInline[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'text' || node.type === 'literal' || node.type === 'code') return node.value;
      if (node.type === 'break') return '\n';
      return textOf(node.children);
    })
    .join('');
}

function headings(blocks: MarkdownBlock[]): string[] {
  return blocks.flatMap((block) => (block.type === 'heading' ? [textOf(block.children)] : []));
}

describe('利用規約とプライバシーポリシーの文面', () => {
  test('版は改定日の YYYY-MM-DD で、実在する日付', () => {
    for (const version of [TERMS_VERSION, PRIVACY_VERSION]) {
      expect(version).toMatch(LEGAL_VERSION_PATTERN);
      expect(new Date(`${version}T00:00:00Z`).toISOString().slice(0, 10)).toBe(version);
    }
  });

  test.each(kinds)('%s: 本文の末尾の改定日と版の定数が一致する', (kind) => {
    const { source, version } = legalDocuments[kind];
    expect(revisedDateOf(source)).toBe(version);
  });

  test('revisedDateOf は、末尾の行が「改定日: YYYY-MM-DD」のときだけ日付を返す', () => {
    expect(revisedDateOf('本文\n\n改定日: 2026-10-31\n')).toBe('2026-10-31');
    expect(revisedDateOf('改定日: 2026-10-31\n\n本文')).toBeUndefined();
    expect(revisedDateOf('改定日: 2026年10月31日')).toBeUndefined();
    expect(revisedDateOf('')).toBeUndefined();
  });

  test.each(kinds)('%s: 画面が描ける（変換が出力の上限に当たらない）', (kind) => {
    const blocks = parseMarkdown(legalDocuments[kind].source);
    expect(blocks).not.toBeNull();
    expect(headings(blocks ?? []).length).toBeGreaterThan(3);
  });

  test.each(kinds)('%s: 運営者の名前と問い合わせ先は、仮の書き方のまま（人が決めて入れる）', (kind) => {
    const { source } = legalDocuments[kind];
    expect(source).toContain('運営者: （運営者の名前を入れる）');
    expect(source).toContain('問い合わせ先: （問い合わせ先を入れる）');
  });

  test('プライバシーポリシーは、預かるもの、預からないもの、消す時期を見出しに持つ', () => {
    const blocks = parseMarkdown(legalDocuments.privacy.source) ?? [];
    const titles = headings(blocks);
    for (const word of ['預かるもの', '預からないもの', '消す時期']) {
      expect(
        titles.some((title) => title.includes(word)),
        word,
      ).toBe(true);
    }
  });

  test('プライバシーポリシーに、取り込み元の本文を既定で預からないこと、解約から30日で消すこと、添付ファイルのバックアップを取らないこと、ログに本文などを出さないことが書かれている', () => {
    const { source } = legalDocuments.privacy;
    expect(source).toContain('取り込み元の本文は、既定では預かりません');
    expect(source).toContain('停止の日から 30 日後に');
    expect(source).toContain('添付ファイルは、バックアップを取りません');
    expect(source).toMatch(/ログに、本文、取り込んだ内容、認証情報/);
  });

  test('利用規約に、自分で作った組織は 30 日のお試しで、過ぎたら一時停止することが書かれている', () => {
    const { source } = legalDocuments.terms;
    expect(source).toContain('自分で作った組織は、作った日から 30 日のお試し');
    expect(source).toContain('お試しの期限が過ぎた組織は、自動で一時停止します');
  });

  test('実在の連絡先を書いていない（メールアドレスと URL を含まない）', () => {
    for (const kind of kinds) {
      expect(legalDocuments[kind].source).not.toMatch(/@|https?:\/\//);
    }
  });
});
