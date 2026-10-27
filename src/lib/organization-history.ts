// 組織の変更の履歴の節（HistorySetting.svelte）が出す、した人と内容の文。種類（organization-history の event.kind）ごとに辞書の1項目。
// 部品から外し、DOM なしで両方の言葉づかいを確かめられるようにする。translate は t（か、言葉づかいを決めた word）
import type { OutputOf } from '../shared/operations/define.ts';
import type { organizationHistory } from '../shared/operations/organization/organization-history.ts';
import type { DictionaryKey, TemplateParams } from '../shared/vocabulary.ts';

export type HistoryEntry = OutputOf<typeof organizationHistory>['entries'][number];

type Translate = (key: DictionaryKey, params?: TemplateParams) => string;

// した人の表示名。users は名前（分からなければ「名前の分からない人」）、運用者は「運用者」だけ、どちらでもなければ「自動の処理」
export function historyActorName(actor: HistoryEntry['actor'], translate: Translate): string {
  switch (actor.kind) {
    case 'user':
      return actor.name ?? translate('orgHistoryUnknownPerson');
    case 'operator':
      return translate('orgHistoryActorOperator');
    case 'system':
      return translate('orgHistoryActorSystem');
  }
}

export function historyEventText(event: HistoryEntry['event'], translate: Translate): string {
  const words = {
    organization: translate('organization'),
    admin: translate('admin'),
    workspace: translate('workspace'),
  };
  const person = (name: string | null) => name ?? translate('orgHistoryUnknownPerson');
  switch (event.kind) {
    case 'organization_created':
      return event.name === null
        ? translate('orgHistoryOrganizationCreatedNoName', words)
        : translate('orgHistoryOrganizationCreated', { ...words, name: event.name });
    case 'organization_suspended':
      return event.purge_on === null
        ? translate('orgHistoryOrganizationSuspendedTemporary', words)
        : translate('orgHistoryOrganizationSuspended', { ...words, date: event.purge_on });
    case 'organization_resumed':
      return translate('orgHistoryOrganizationResumed', words);
    case 'organization_suspension_changed':
      return event.purge_on === null
        ? translate('orgHistorySuspensionChangedTemporary', words)
        : translate('orgHistorySuspensionChanged', { ...words, date: event.purge_on });
    case 'organization_settings_changed':
      return translate('orgHistoryOrganizationSettingsChanged', words);
    case 'admin_designated':
      return event.name === null
        ? translate('orgHistoryAdminDesignatedGoogle', words)
        : translate('orgHistoryAdminDesignated', { ...words, name: event.name });
    case 'admin_login_linked':
      return translate('orgHistoryAdminLoginLinked', { ...words, name: person(event.name) });
    case 'admin_designation_merged':
      return translate('orgHistoryAdminDesignationMerged', { ...words, name: person(event.name) });
    case 'admin_revoked':
      return translate('orgHistoryAdminRevoked', { ...words, name: person(event.name) });
    case 'user_disabled':
      return translate('orgHistoryUserDisabled', { ...words, name: person(event.name) });
    case 'user_enabled':
      return translate('orgHistoryUserEnabled', { ...words, name: person(event.name) });
    // ワークスペースの名前が分からない行（ワークスペースの行が無い）は、名前を添えない文にする
    case 'workspace_created':
      return event.workspace_name === null
        ? translate('orgHistoryWorkspaceCreatedNoName', words)
        : translate('orgHistoryWorkspaceCreated', { ...words, name: event.workspace_name });
    case 'workspace_closed':
      return event.workspace_name === null
        ? translate('orgHistoryWorkspaceClosedNoName', words)
        : translate('orgHistoryWorkspaceClosed', { ...words, name: event.workspace_name });
    case 'workspace_reopened':
      return event.workspace_name === null
        ? translate('orgHistoryWorkspaceReopenedNoName', words)
        : translate('orgHistoryWorkspaceReopened', { ...words, name: event.workspace_name });
    // 運用者が指名し直したときに消した、まだログインしていない前の指名。Google で待っていた行は名前が無い
    case 'admin_designation_removed':
      return event.name === null
        ? translate('orgHistoryAdminDesignationRemovedNoName', words)
        : translate('orgHistoryAdminDesignationRemoved', { ...words, name: event.name });
    case 'other':
      return translate('orgHistoryOther', words);
  }
}
