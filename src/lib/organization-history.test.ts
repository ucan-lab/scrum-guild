import { describe, expect, test } from 'vitest';
import { word, type DictionaryKey, type TemplateParams, type Vocabulary } from '../shared/vocabulary.ts';
import { historyActorName, historyEventText, type HistoryEntry } from './organization-history.ts';

function translator(vocabulary: Vocabulary) {
  return (key: DictionaryKey, params?: TemplateParams) =>
    word(key, { workspace: vocabulary, organization: vocabulary }, params);
}

const game = translator('game');
const scrum = translator('scrum');

describe('historyEventText', () => {
  test('種類ごとに、辞書の文を作る', () => {
    const cases: [HistoryEntry['event'], string, string][] = [
      [
        { kind: 'organization_created', name: 'あおば開発' },
        '冒険者ギルド「あおば開発」を作りました',
        '組織「あおば開発」を作りました',
      ],
      [{ kind: 'organization_created', name: null }, '冒険者ギルドを作りました', '組織を作りました'],
      [
        { kind: 'organization_suspended', purge_on: '2026-11-25' },
        '冒険者ギルドを停止しました（消す予定日 2026-11-25）',
        '組織を停止しました（消す予定日 2026-11-25）',
      ],
      [
        { kind: 'organization_suspended', purge_on: null },
        '冒険者ギルドを一時的に停止しました',
        '組織を一時的に停止しました',
      ],
      [{ kind: 'organization_resumed' }, '冒険者ギルドを再開しました', '組織を再開しました'],
      [
        { kind: 'organization_suspension_changed', purge_on: '2026-11-25' },
        '停止の理由を解約に切り替えました（消す予定日 2026-11-25）',
        '停止の理由を解約に切り替えました（消す予定日 2026-11-25）',
      ],
      [
        { kind: 'organization_suspension_changed', purge_on: null },
        '停止の理由を一時的な停止に切り替えました',
        '停止の理由を一時的な停止に切り替えました',
      ],
      [{ kind: 'organization_settings_changed' }, '冒険者ギルドの設定を変更しました', '組織の設定を変更しました'],
      [
        { kind: 'admin_designated', name: 'ミナト' },
        'ミナトをギルドマスターに指名しました',
        'ミナトを管理者に指名しました',
      ],
      [
        { kind: 'admin_designated', name: null },
        'Google で招待した人をギルドマスターに指名しました',
        'Google で招待した人を管理者に指名しました',
      ],
      [
        { kind: 'admin_login_linked', name: 'ハルカ' },
        'ハルカが Google でログインし、ギルドマスターの指名を受けました',
        'ハルカが Google でログインし、管理者の指名を受けました',
      ],
      [
        { kind: 'admin_designation_merged', name: 'ハルカ' },
        'Google の招待で、ハルカをギルドマスターにしました',
        'Google の招待で、ハルカを管理者にしました',
      ],
      [
        { kind: 'admin_designation_removed', name: 'ソラ' },
        'ソラへのギルドマスターの指名を取り消しました',
        'ソラへの管理者の指名を取り消しました',
      ],
      [
        { kind: 'admin_designation_removed', name: null },
        'Google で招待した人へのギルドマスターの指名を取り消しました',
        'Google で招待した人への管理者の指名を取り消しました',
      ],
      [{ kind: 'admin_revoked', name: 'リン' }, 'リンのギルドマスターを解除しました', 'リンの管理者を解除しました'],
      [
        { kind: 'user_disabled', name: null },
        '名前の分からない人を無効にしました',
        '名前の分からない人を無効にしました',
      ],
      [{ kind: 'user_enabled', name: 'カイ' }, 'カイを有効に戻しました', 'カイを有効に戻しました'],
      [
        { kind: 'workspace_created', workspace_name: '受託開発チーム' },
        'パーティ「受託開発チーム」を作りました',
        'ワークスペース「受託開発チーム」を作りました',
      ],
      [{ kind: 'workspace_created', workspace_name: null }, 'パーティを作りました', 'ワークスペースを作りました'],
      [
        { kind: 'workspace_closed', workspace_name: '旧サイト保守' },
        'パーティ「旧サイト保守」を終了しました',
        'ワークスペース「旧サイト保守」を終了しました',
      ],
      [{ kind: 'workspace_closed', workspace_name: null }, 'パーティを終了しました', 'ワークスペースを終了しました'],
      [{ kind: 'workspace_reopened', workspace_name: null }, 'パーティを再開しました', 'ワークスペースを再開しました'],
      [
        { kind: 'workspace_reopened', workspace_name: '旧サイト保守' },
        'パーティ「旧サイト保守」を再開しました',
        'ワークスペース「旧サイト保守」を再開しました',
      ],
      [{ kind: 'other' }, '冒険者ギルドを変更しました', '組織を変更しました'],
    ];
    for (const [event, gameText, scrumText] of cases) {
      expect(historyEventText(event, game), event.kind).toBe(gameText);
      expect(historyEventText(event, scrum), event.kind).toBe(scrumText);
    }
  });
});

describe('historyActorName', () => {
  test('人は名前、運用者は「運用者」、どちらでもなければ「自動の処理」', () => {
    expect(historyActorName({ kind: 'user', id: 'u1', name: 'ミナト' }, game)).toBe('ミナト');
    expect(historyActorName({ kind: 'user', id: 'u1', name: null }, game)).toBe('名前の分からない人');
    expect(historyActorName({ kind: 'operator' }, scrum)).toBe('運用者');
    expect(historyActorName({ kind: 'system' }, scrum)).toBe('自動の処理');
  });
});
