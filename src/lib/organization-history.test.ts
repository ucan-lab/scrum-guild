import { describe, expect, test } from 'vitest';
import { word, type DictionaryKey, type TemplateParams } from '../shared/vocabulary.ts';
import { historyActorName, historyEventText, type HistoryEntry } from './organization-history.ts';

const t = (key: DictionaryKey, params?: TemplateParams) => word(key, params);

describe('historyEventText', () => {
  test('種類ごとに、辞書の文を作る', () => {
    const cases: [HistoryEntry['event'], string][] = [
      [{ kind: 'organization_created', name: 'あおば開発' }, '組織「あおば開発」を作りました'],
      [{ kind: 'organization_created', name: null }, '組織を作りました'],
      [{ kind: 'organization_suspended', purge_on: '2026-11-25' }, '組織を停止しました（消す予定日 2026-11-25）'],
      [{ kind: 'organization_suspended', purge_on: null }, '組織を一時的に停止しました'],
      [{ kind: 'organization_resumed' }, '組織を再開しました'],
      [
        { kind: 'organization_suspension_changed', purge_on: '2026-11-25' },
        '停止の理由を解約に切り替えました（消す予定日 2026-11-25）',
      ],
      [{ kind: 'organization_suspension_changed', purge_on: null }, '停止の理由を一時的な停止に切り替えました'],
      [{ kind: 'organization_settings_changed' }, '組織の設定を変更しました'],
      [{ kind: 'admin_designated', name: 'ミナト' }, 'ミナトを管理者に指名しました'],
      [{ kind: 'admin_designated', name: null }, 'Google で招待した人を管理者に指名しました'],
      [{ kind: 'admin_login_linked', name: 'ハルカ' }, 'ハルカが Google でログインし、管理者の指名を受けました'],
      [{ kind: 'admin_designation_merged', name: 'ハルカ' }, 'Google の招待で、ハルカを管理者にしました'],
      [{ kind: 'admin_designation_removed', name: 'ソラ' }, 'ソラへの管理者の指名を取り消しました'],
      [{ kind: 'admin_designation_removed', name: null }, 'Google で招待した人への管理者の指名を取り消しました'],
      [{ kind: 'admin_revoked', name: 'リン' }, 'リンの管理者を解除しました'],
      [{ kind: 'user_disabled', name: null }, '名前の分からない人を無効にしました'],
      [{ kind: 'user_enabled', name: 'カイ' }, 'カイを有効に戻しました'],
      [{ kind: 'workspace_created', workspace_name: '受託開発チーム' }, 'ワークスペース「受託開発チーム」を作りました'],
      [{ kind: 'workspace_created', workspace_name: null }, 'ワークスペースを作りました'],
      [{ kind: 'workspace_closed', workspace_name: '旧サイト保守' }, 'ワークスペース「旧サイト保守」を終了しました'],
      [{ kind: 'workspace_closed', workspace_name: null }, 'ワークスペースを終了しました'],
      [{ kind: 'workspace_reopened', workspace_name: null }, 'ワークスペースを再開しました'],
      [{ kind: 'workspace_reopened', workspace_name: '旧サイト保守' }, 'ワークスペース「旧サイト保守」を再開しました'],
      [{ kind: 'other' }, '組織を変更しました'],
    ];
    for (const [event, text] of cases) {
      expect(historyEventText(event, t), event.kind).toBe(text);
    }
  });
});

describe('historyActorName', () => {
  test('人は名前、運用者は「運用者」、どちらでもなければ「自動の処理」', () => {
    expect(historyActorName({ kind: 'user', id: 'u1', name: 'ミナト' }, t)).toBe('ミナト');
    expect(historyActorName({ kind: 'user', id: 'u1', name: null }, t)).toBe('名前の分からない人');
    expect(historyActorName({ kind: 'operator' }, t)).toBe('運用者');
    expect(historyActorName({ kind: 'system' }, t)).toBe('自動の処理');
  });
});
