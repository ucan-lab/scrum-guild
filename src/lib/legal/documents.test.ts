// 利用規約とプライバシーポリシーの文面（Markdown）と版の照合。文面は人が直すので、直し忘れ（末尾の改定日と版の食い違い）だけを止め、
// 言い回しは固定しない（見出しと、要点の短い語だけを見る）
import { describe, expect, test } from 'vitest';
import { parseMarkdown, type MarkdownBlock, type MarkdownInline } from '../markdown.ts';
import {
  bodyOf,
  latestHistoryDate,
  legalDocuments,
  REVISION_HISTORY_HEADING,
  revisedDateOf,
  splitRevisionHistory,
  type LegalKind,
} from './documents.ts';
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

  test.each(kinds)('%s: 文面の末尾に「改定の履歴」の節があり、最初の行は制定で、本文には残らない', (kind) => {
    const { source, body, history } = legalDocuments[kind];
    expect(source).toContain(`\n${REVISION_HISTORY_HEADING}\n`);
    expect(history.split('\n')[0]).toBe(REVISION_HISTORY_HEADING);
    expect(history).toMatch(/^- 2026-10-31 制定$/m);
    expect(body).not.toContain(REVISION_HISTORY_HEADING);
    // 運営者と問い合わせ先の節の後、改定日の行の前に置く
    expect(source.indexOf('# 運営者と問い合わせ先')).toBeLessThan(source.indexOf(REVISION_HISTORY_HEADING));
    expect(source.indexOf(REVISION_HISTORY_HEADING)).toBeLessThan(source.lastIndexOf('改定日: '));
  });

  // 版を上げたのに履歴へ1行足し忘れると、同意の画面の「改定の履歴を見る」が、改めた根拠を示さない履歴を指す
  test.each(kinds)('%s: 履歴の最も新しい日付が、版と一致する', (kind) => {
    const { history, version } = legalDocuments[kind];
    expect(latestHistoryDate(history)).toBe(version);
  });

  test('latestHistoryDate は、履歴の並びによらず最も新しい日付を返し、日付の行が無ければ undefined', () => {
    const entries = ['- 2026-10-31 制定', '- 2027-02-01 第5条を改めた', '- 2026-12-15 第3条を改めた'];
    expect(latestHistoryDate(['# 改定の履歴', '', ...entries].join('\n'))).toBe('2027-02-01');
    expect(latestHistoryDate(['# 改定の履歴', '', ...entries.toReversed()].join('\n'))).toBe('2027-02-01');
    // 箇条書きの形でない日付（本文中の日付、日付だけの行）は数えない
    expect(latestHistoryDate('# 改定の履歴\n\n2028-01-01 は予定\n- 2026-10-31')).toBeUndefined();
    expect(latestHistoryDate('')).toBeUndefined();
  });

  test.each(kinds)('%s: 履歴の節が画面に描ける。見出しは1つで、箇条書きを持つ', (kind) => {
    const blocks = parseMarkdown(legalDocuments[kind].history);
    expect(blocks).not.toBeNull();
    expect(headings(blocks ?? [])).toEqual(['改定の履歴']);
    expect(blocks?.some((block) => block.type === 'list')).toBe(true);
  });

  test('splitRevisionHistory は、履歴の節だけを本文から分ける', () => {
    expect(splitRevisionHistory('# 第1条\n\n本文\n\n# 改定の履歴\n\n- 2026-10-31 制定')).toEqual({
      body: '# 第1条\n\n本文',
      history: '# 改定の履歴\n\n- 2026-10-31 制定',
    });
  });

  test('splitRevisionHistory は、履歴の節が途中にあれば、次の見出しの手前までを履歴にして、残りを本文に戻す', () => {
    expect(splitRevisionHistory('# 第1条\n\n本文\n\n# 改定の履歴\n\n- 2026-10-31 制定\n\n# 第2条\n\n続き')).toEqual({
      body: '# 第1条\n\n本文\n\n# 第2条\n\n続き',
      history: '# 改定の履歴\n\n- 2026-10-31 制定',
    });
  });

  test('splitRevisionHistory は、履歴の節が無い文面では履歴を空として扱い、本文をそのまま返す', () => {
    const body = '# 第1条\n\n本文';
    expect(splitRevisionHistory(body)).toEqual({ body, history: '' });
    // 見出しの行が完全に一致しないもの（段が違う、語が違う）は節とみなさない
    expect(splitRevisionHistory('## 改定の履歴\n\n- a').history).toBe('');
    expect(splitRevisionHistory('# 改定の履歴について\n\n- a').history).toBe('');
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
