// 利用規約とプライバシーポリシーの文面（Markdown）と版の照合。文面は人が直すので、直し忘れ（末尾の改定日と版の食い違い）だけを止め、
// 言い回しは固定しない（見出しと、要点の短い語だけを見る）
import { describe, expect, test } from 'vitest';
import { parseMarkdown, type MarkdownBlock, type MarkdownInline } from '../markdown.ts';
import { bodyOf, legalDocuments, revisedDateOf, type LegalKind } from './documents.ts';
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

  test('bodyOf は末尾の改定日の行（とその前の空行）だけを落とす', () => {
    expect(bodyOf('# 第1条\n\n本文\n\n改定日: 2026-10-31\n')).toBe('# 第1条\n\n本文');
    expect(bodyOf('本文\n\n改定日の話')).toBe('本文\n\n改定日の話');
    for (const kind of kinds) {
      const { source, body } = legalDocuments[kind];
      expect(body).not.toMatch(/^改定日: /m);
      expect(body.length).toBeLessThan(source.length);
    }
  });

  test.each(kinds)('%s: 画面が描ける（変換が出力の上限に当たらない）', (kind) => {
    const blocks = parseMarkdown(legalDocuments[kind].body);
    expect(blocks).not.toBeNull();
    expect(headings(blocks ?? []).length).toBeGreaterThan(3);
  });

  test('プライバシーポリシーは、預かるもの、預からないもの、消す時期を見出しに持つ', () => {
    const titles = headings(parseMarkdown(legalDocuments.privacy.body) ?? []);
    for (const word of ['預かるもの', '預からないもの', '消す時期']) {
      expect(
        titles.some((title) => title.includes(word)),
        word,
      ).toBe(true);
    }
  });

  test('プライバシーポリシーは、取り込み元の本文と、解約から 30 日に触れている', () => {
    const { body } = legalDocuments.privacy;
    expect(body).toContain('取り込み元の本文');
    expect(body).toContain('30 日');
  });
});
