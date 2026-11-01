import { t } from './vocabulary.svelte.ts';

// 招待の承諾と辞退（invitation-accept、invitation-decline）の画面が共に使う文言。
// 招待の画面（InvitationInbox）と、自分の設定の「届いた招待」（MeInvitations）が同じ理由の文にそろえる

export function invitationRoleLabel(role: 'leader' | 'member'): string {
  return role === 'leader' ? t('leader') : t('roleMember');
}

// 失敗の理由。status 0 は通信できなかったとき
export function invitationErrorText(result: { status: number; error?: { code: string } | null }): string {
  const words = { workspace: t('workspace') };
  if (result.status === 0) return t('invitationErrorUnreachable');
  switch (result.error?.code) {
    case 'not_found':
      return t('invitationErrorNotFound');
    case 'conflict':
      return t('invitationErrorChanged');
    case 'workspace_closed':
      return t('invitationErrorClosed', words);
    case 'already_member':
      return t('invitationErrorAlreadyMember', words);
    default:
      return t('invitationErrorFailed');
  }
}
