<script lang="ts">
  import { tick } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { userAdminUpdate, userDisable, userEnable, userList } from '../../../shared/operations/organization/index.ts';
  import { userConflictReasonOf } from '../../../shared/operations/organization/user.ts';
  import type { OutputOf } from '../../../shared/operations/define.ts';
  import { callOperation, type ApiResult } from '../../api.ts';
  import { formatLocalDate } from '../../format.ts';
  import { isUnauthenticated, loginUrl } from '../../login-redirect.ts';
  import { showToast } from '../../toast.svelte.ts';
  import { t } from '../../vocabulary.svelte.ts';
  import Avatar from '../Avatar.svelte';
  import ConfirmDialog from '../ConfirmDialog.svelte';
  import Setting from '../Setting.svelte';
  import SectionBoundary from './SectionBoundary.svelte';
  import { SectionLoad } from './section-load.svelte.ts';

  // 組織の管理の画面（admin.html）の「ユーザー」の節。読み込みの状態は SectionLoad、その表示は SectionBoundary に任せる
  // （WorkspacesSetting と同じ形）。
  // 行: 名前（アバター付き）と無効の印、管理者の切り替え、所属の数、最後に入った日、無効にする／有効に戻す。
  // - 自分の行には「無効にする」を出さない（API も 409 の self で断る）。無効の人の切り替えは押せない（disabled）
  // - 「無効にする」は確認のダイアログを経る。所属と担当が外れ、有効に戻しても招待し直しが要ることを伝える
  // - 自分の管理者の解除も確認を経る。解除できたら、組織の枠（管理者の判定）を読み直す（この画面は「見つからない」になる）
  // - 409 は理由（details.reason）ごとに、そのほかの失敗は種類ごとにトーストで知らせ、一覧を読み直す
  // 操作は1件ずつ送り、送っている間はどの行の操作も aria-disabled にして押しても無視する。
  // 画面の見出しの集計（無効でないユーザーの数、管理者の数）は oncounts で渡す（読めるまでは null）
  let {
    slug,
    meId,
    oncounts,
  }: {
    slug: string;
    meId: string;
    oncounts: (counts: { users: number; admins: number } | null) => void;
  } = $props();

  type User = OutputOf<typeof userList>['users'][number];

  // 組織の枠のデータを読み直すと slug の props は新しい getter になるが、値が同じなら $derived は変わらない
  const currentSlug = $derived(slug);

  let users = $state<User[]>([]);
  // 操作を送っている行
  let busyId = $state<string | null>(null);
  let confirmDialog = $state<ReturnType<typeof ConfirmDialog>>();
  // 確かめのダイアログで聞いている操作。disable は無効にする、revokeSelf は自分の管理者の解除
  let pending = $state<{ kind: 'disable' | 'revokeSelf'; user: User } | null>(null);

  const section = new SectionLoad(
    () => callOperation(userList, {}, { slug: currentSlug }),
    (data) => {
      users = data.users;
      oncounts({
        users: data.users.filter((user) => user.disabled_at === null).length,
        admins: data.users.filter((user) => user.is_admin && user.disabled_at === null).length,
      });
    },
  );

  // slug が替わったら、前の組織の一覧を捨てて読み直す
  section.attach(
    () => currentSlug,
    () => {
      users = [];
      oncounts(null);
      busyId = null;
    },
  );

  const words = $derived({
    admin: t('admin'),
    organization: t('organization'),
    workspace: t('workspace'),
    task: t('task'),
  });

  async function confirmAction(next: NonNullable<typeof pending>, trigger: HTMLElement | null): Promise<boolean> {
    pending = next;
    return (await confirmDialog?.ask(trigger)) ?? false;
  }

  // 失敗を知らせる。403 は管理者でなくなったので、組織の枠を読み直す（この画面は「見つからない」になる）
  async function reportFailure(result: Exclude<ApiResult<unknown>, { ok: true }>, user: User): Promise<void> {
    if (isUnauthenticated(result)) {
      window.location.assign(loginUrl(page.url));
      return;
    }
    const name = user.name;
    if (result.status === 409 && result.error?.code === 'conflict') {
      const reason = userConflictReasonOf(result.error.details);
      if (reason === 'last_admin') showToast(t('userErrorLastAdmin', words), 'alert');
      else if (reason === 'self') showToast(t('userErrorSelf'), 'alert');
      else if (reason === 'disabled') showToast(t('userErrorDisabled', words), 'alert');
      else if (reason === 'member_limit') showToast(t('userErrorMemberLimit', { ...words, name }), 'alert');
      else showToast(t('userErrorChanged', { name }), 'alert');
    } else if (result.status === 403) {
      showToast(t('userErrorForbidden', words), 'alert');
      await invalidateAll();
      return;
    } else if (result.status === 404) showToast(t('userErrorNotFound', { name }), 'alert');
    else if (result.status === 0) showToast(t('userErrorUnreachable'), 'alert');
    else showToast(t('userUpdateFailed', { name }), 'alert');
  }

  // 送っている間に押された切り替えは、変わらないよう止める（aria-disabled は押すことを止めない）
  function guardToggle(event: MouseEvent): void {
    if (busyId !== null) event.preventDefault();
  }

  async function toggleAdmin(user: User, event: Event & { currentTarget: HTMLInputElement }): Promise<void> {
    const input = event.currentTarget;
    const next = input.checked;
    if (busyId !== null || user.disabled_at !== null) {
      input.checked = user.is_admin;
      return;
    }
    const self = user.id === meId;
    if (self && !next && !(await confirmAction({ kind: 'revokeSelf', user }, input))) {
      input.checked = user.is_admin;
      return;
    }
    const token = section.token();
    busyId = user.id;
    try {
      const result = await callOperation(userAdminUpdate, { user_id: user.id, is_admin: next }, { slug: currentSlug });
      if (!section.isCurrent(token)) return;
      if (result.ok) {
        showToast(t(next ? 'userDesignated' : 'userRevoked', { name: user.name, admin: t('admin') }), 'check');
        // 自分を解除したら、管理者の判定を読み直す（この画面は「見つからない」になる）
        if (self && !next) {
          await invalidateAll();
          return;
        }
      } else {
        input.checked = user.is_admin;
        await reportFailure(result, user);
      }
      await section.load();
    } finally {
      if (section.isCurrent(token)) busyId = null;
    }
  }

  async function toggleDisabled(user: User, trigger: HTMLElement): Promise<void> {
    if (busyId !== null) return;
    const disabling = user.disabled_at === null;
    if (disabling && !(await confirmAction({ kind: 'disable', user }, trigger))) return;
    const token = section.token();
    busyId = user.id;
    try {
      const result = disabling
        ? await callOperation(userDisable, { user_id: user.id }, { slug: currentSlug })
        : await callOperation(userEnable, { user_id: user.id }, { slug: currentSlug });
      if (!section.isCurrent(token)) return;
      if (result.ok) {
        showToast(
          disabling
            ? t('userDisabled', { name: user.name })
            : t('userEnabled', { name: user.name, workspace: t('workspace') }),
          'check',
        );
      } else {
        await reportFailure(result, user);
        if (result.status === 403) return;
      }
      await section.load();
    } finally {
      if (section.isCurrent(token)) busyId = null;
    }
    // 読み直しても行は残り、ボタンは文字だけを替える。押した行のボタンへフォーカスを戻す
    await tick();
    document.querySelector<HTMLButtonElement>(`[data-user-action="${CSS.escape(user.id)}"]`)?.focus();
  }

  const status = $derived(busyId !== null ? t('userWorking') : '');
</script>

<Setting title={t('userSectionTitle')} description={t('userSectionDesc', words)}>
  <SectionBoundary {section} failedTitle={t('userListLoadFailed')} refreshFailedText={t('userListRefreshFailed')}>
    <div class="table-wrap">
      <!-- 行の操作（切り替えとボタン）を持つので、狭い幅で1行を縦に積む（is-stacked） -->
      <table class="table is-stacked" aria-label={t('userListLabel', words)}>
        <thead>
          <tr>
            <th class="is-name">{t('fieldName')}</th>
            <th>{t('admin')}</th>
            <th class="is-num">{t('userWorkspaceCountHeader')}</th>
            <th>{t('userLastSeenHeader')}</th>
            <th class="is-actions"><span class="visually-hidden">{t('userActionsHeader')}</span></th>
          </tr>
        </thead>
        <tbody>
          {#each users as user (user.id)}
            {@const self = user.id === meId}
            <tr>
              <td class="is-name">
                <span class="person is-wrap"
                  ><Avatar userId={user.id} name={user.name} image={user.avatar_url} decorative />{user.name}</span
                >
                {#if user.disabled_at !== null}
                  <span class="chip">{t('userDisabledChip')}</span>
                {/if}
              </td>
              <td data-label={t('admin')}>
                <label class="toggle">
                  <input
                    type="checkbox"
                    checked={user.is_admin}
                    disabled={user.disabled_at !== null}
                    aria-disabled={busyId !== null}
                    aria-label={t('userAdminToggleLabel', { name: user.name, admin: t('admin') })}
                    onclick={guardToggle}
                    onchange={(event) => void toggleAdmin(user, event)}
                  />
                </label>
              </td>
              <td class="is-num" data-label={t('userWorkspaceCountHeader')}>{user.workspace_count}</td>
              <td class="mono" data-label={t('userLastSeenHeader')}>
                {user.last_seen_at === null ? t('userNeverSeen') : formatLocalDate(user.last_seen_at)}
              </td>
              <td class="is-actions">
                {#if user.disabled_at !== null}
                  <button
                    class="btn is-sm is-quiet"
                    type="button"
                    data-user-action={user.id}
                    aria-disabled={busyId !== null}
                    aria-label={t('userEnableLabel', { name: user.name })}
                    onclick={(event) => void toggleDisabled(user, event.currentTarget)}>{t('userEnableAction')}</button
                  >
                {:else if !self}
                  <button
                    class="btn is-sm is-quiet is-danger"
                    type="button"
                    data-user-action={user.id}
                    aria-disabled={busyId !== null}
                    aria-label={t('userDisableLabel', { name: user.name })}
                    onclick={(event) => void toggleDisabled(user, event.currentTarget)}>{t('userDisableAction')}</button
                  >
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </SectionBoundary>
  <!-- 送っている間の読み上げ。領域は常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{status}</span>
</Setting>

<ConfirmDialog
  bind:this={confirmDialog}
  title={pending?.kind === 'revokeSelf'
    ? t('userRevokeSelfTitle', words)
    : t('userDisableTitle', { name: pending?.user.name ?? '' })}
  confirmLabel={pending?.kind === 'revokeSelf' ? t('userRevokeSelfConfirm') : t('userDisableAction')}
  cancelLabel={t('cancel')}
  danger
>
  {#if pending?.kind === 'revokeSelf'}
    <p>{t('userRevokeSelfText', words)}</p>
  {:else if pending !== null}
    <p>{t('userDisableText', { ...words, name: pending.user.name })}</p>
    {#if pending.user.is_admin}<p>{t('userDisableAdminNote', words)}</p>{/if}
    <p>{t('userDisableEnableNote', words)}</p>
  {/if}
</ConfirmDialog>
