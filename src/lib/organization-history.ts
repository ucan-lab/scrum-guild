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
      return actor.name ?? translate('historyUnknownPerson');
    case 'operator':
      return translate('historyActorOperator');
    case 'system':
      return translate('historyActorSystem');
  }
}

export function historyEventText(event: HistoryEntry['event'], translate: Translate): string {
  const words = {
    organization: translate('organization'),
    admin: translate('admin'),
    workspace: translate('workspace'),
  };
  const person = (name: string | null) => name ?? translate('historyUnknownPerson');
  switch (event.kind) {
    case 'organization_created':
      return event.name === null
        ? translate('historyOrganizationCreatedNoName', words)
        : translate('historyOrganizationCreated', { ...words, name: event.name });
    case 'organization_suspended':
      return event.purge_on === null
        ? translate('historyOrganizationSuspendedTemporary', words)
        : translate('historyOrganizationSuspended', { ...words, date: event.purge_on });
    case 'organization_resumed':
      return translate('historyOrganizationResumed', words);
    case 'organization_suspension_changed':
      return event.purge_on === null
        ? translate('historySuspensionChangedTemporary', words)
        : translate('historySuspensionChanged', { ...words, date: event.purge_on });
    case 'organization_settings_changed':
      return translate('historyOrganizationSettingsChanged', words);
    case 'admin_designated':
      return event.name === null
        ? translate('historyAdminDesignatedGoogle', words)
        : translate('historyAdminDesignated', { ...words, name: event.name });
    case 'admin_login_linked':
      return translate('historyAdminLoginLinked', { ...words, name: person(event.name) });
    case 'admin_designation_merged':
      return translate('historyAdminDesignationMerged', { ...words, name: person(event.name) });
    case 'admin_revoked':
      return translate('historyAdminRevoked', { ...words, name: person(event.name) });
    case 'user_disabled':
      return translate('historyUserDisabled', { ...words, name: person(event.name) });
    case 'user_enabled':
      return translate('historyUserEnabled', { ...words, name: person(event.name) });
    // ワークスペースの名前が分からない行（ワークスペースの行が無い）は、名前を添えない文にする
    case 'workspace_created':
      return event.workspace_name === null
        ? translate('historyWorkspaceCreatedNoName', words)
        : translate('historyWorkspaceCreated', { ...words, name: event.workspace_name });
    case 'workspace_closed':
      return event.workspace_name === null
        ? translate('historyWorkspaceClosedNoName', words)
        : translate('historyWorkspaceClosed', { ...words, name: event.workspace_name });
    case 'workspace_reopened':
      return event.workspace_name === null
        ? translate('historyWorkspaceReopenedNoName', words)
        : translate('historyWorkspaceReopened', { ...words, name: event.workspace_name });
    case 'other':
      return translate('historyOther', words);
  }
}
