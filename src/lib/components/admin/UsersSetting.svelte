<script lang="ts">
  import { tick } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { userAdminUpdate, userDisable, userEnable, userList } from '../../../shared/operations/organization/index.ts';
  import { userConflictReasonOf } from '../../../shared/operations/organization/user.ts';
  import type { OutputOf } from '../../../shared/operations/define.ts';
  import { callOperation, type ApiResult } from '../../api.ts';
  import { focusPageHeading } from '../../focus-heading.ts';
  import { formatLocalDate } from '../../format.ts';
  import { isUnauthenticated, loginUrl } from '../../login-redirect.ts';
  import { memberLimitDetailsOf } from '../../member-limit-details.ts';
  import { showToast } from '../../toast.svelte.ts';
  import { t } from '../../vocabulary.svelte.ts';
  import Avatar from '../Avatar.svelte';
  import ConfirmDialog from '../ConfirmDialog.svelte';
  import Icon from '../Icon.svelte';
  import Setting from '../Setting.svelte';
  import SectionBoundary from './SectionBoundary.svelte';
  import { SectionLoad } from './section-load.svelte.ts';

  // 組織の管理の画面（admin.html）の「ユーザー」の節。読み込みの状態は SectionLoad、その表示は SectionBoundary に任せる
  // （WorkspacesSetting と同じ形）。
  // 行: 名前（アバター付き）と無効の印、管理者の切り替え、所属の数、最後に入った日、無効にする／有効に戻す。
  // - 自分の行には「無効にする」を出さない（API も 409 の self で断る）。無効の人の切り替えは押せない（disabled）
  // - 「無効にする」は確認のダイアログを経る。所属と担当が外れ、有効に戻しても招待し直しが要ることを伝える
  // - 自分の管理者の解除も確認を経る（待つ間、切り替えは今の値のまま）。無効でない管理者が自分だけなら、確認を出さずにその場で断る。
  //   解除できたら、組織の枠（管理者の判定）を読み直し（この画面は「見つからない」になる）、見出しへフォーカスを移す
  // - 通ったら、応答の値で行を先に書き換えてから読み直す（読み直しが失敗しても、見た目が書いた後の値とずれない）
  // - 無効の人の押せない切り替えには、理由を読み上げの説明（aria-describedby）で結ぶ。入ったことの無い人の「—」には見えない文字を添える
  // - 409 は理由（details.reason）ごとに、そのほかの失敗は種類ごとにトーストで知らせ、一覧を読み直す。
  //   有効に戻すのが人数の上限で断られた（409 の member_limit_reached）ときだけは、長い理由と対処を表の上のコールアウトに残す
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
  // 有効に戻すのが人数の上限で断られた理由。読み返せるよう、トーストでなく表の上のコールアウトに残す。
  // 次に有効に戻す／無効にするを押したとき、組織が替わったときに消し、一覧を読み直しても残す
  let enableRefusal = $state<string | null>(null);
  let refusalBox = $state<HTMLElement>();
  let confirmDialog = $state<ReturnType<typeof ConfirmDialog>>();
  // 確かめのダイアログで聞いている操作。disable は無効にする、revokeSelf は自分の管理者の解除
  let pending = $state<{ kind: 'disable' | 'revokeSelf'; user: User } | null>(null);

  // 読み上げの説明（aria-describedby）の id の前置き
  const uid = $props.id();

  // 一覧を入れ替え、見出しの集計を渡す。読み込みのほか、操作が通ったときに応答の値で先に行を書き換えるのにも使う
  // （読み直しが失敗しても、見た目が書いた後の値とずれないように）
  function applyUsers(next: User[]): void {
    users = next;
    oncounts({
      users: next.filter((user) => user.disabled_at === null).length,
      admins: next.filter((user) => user.is_admin && user.disabled_at === null).length,
    });
  }

  function applyState(state: { user_id: string; is_admin: boolean; disabled_at: string | null }): void {
    applyUsers(
      users.map((user) =>
        user.id === state.user_id ? { ...user, is_admin: state.is_admin, disabled_at: state.disabled_at } : user,
      ),
    );
  }

  // 無効でない管理者の数。自分しかいなければ、自分の解除は送らずに断る
  const activeAdminCount = $derived(users.filter((user) => user.is_admin && user.disabled_at === null).length);

  const section = new SectionLoad(
    () => callOperation(userList, {}, { slug: currentSlug }),
    (data) => applyUsers(data.users),
  );

  // slug が替わったら、前の組織の一覧を捨てて読み直す
  section.attach(
    () => currentSlug,
    () => {
      users = [];
      oncounts(null);
      busyId = null;
      enableRefusal = null;
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

  // 失敗を知らせる。401 はログインへ移し、403 は管理者でなくなったので、組織の枠を読み直す（この画面は「見つからない」になる）。
  // どちらも画面を離れるので真を返し、呼び出し側は一覧を読み直さない
  async function reportFailure(result: Exclude<ApiResult<unknown>, { ok: true }>, user: User): Promise<boolean> {
    if (isUnauthenticated(result)) {
      window.location.assign(loginUrl(page.url));
      return true;
    }
    const name = user.name;
    if (result.status === 409 && result.error?.code === 'member_limit_reached') {
      // 有効に戻すのが人数の上限で断られた。長い理由と対処は、トーストでなく表の上のコールアウトに残す。
      // 数が読めない応答（details が無いか不正）は、数を含まない文言にする
      const seats = memberLimitDetailsOf(result.error.details);
      const common = { ...words, name, leader: t('leader') };
      enableRefusal =
        seats === undefined
          ? t('userEnableMemberLimitUnknown', common)
          : t('userEnableMemberLimit', { ...common, adding: seats.adding, used: seats.used, limit: seats.limit });
      // 押した行が表の下にあっても理由が見えるよう、描いた後に画面の中へ動かす。フォーカスは押したボタンに残す
      await tick();
      refusalBox?.scrollIntoView({ block: 'nearest' });
    } else if (result.status === 409 && result.error?.code === 'conflict') {
      const reason = userConflictReasonOf(result.error.details);
      if (reason === 'last_admin') showToast(t('userErrorLastAdmin', words), 'alert');
      else if (reason === 'self') showToast(t('userErrorSelf'), 'alert');
      else if (reason === 'disabled') showToast(t('userErrorDisabled', words), 'alert');
      else if (reason === 'member_limit') showToast(t('userErrorMemberLimit', { ...words, name }), 'alert');
      else showToast(t('userErrorChanged', { name }), 'alert');
    } else if (result.status === 403) {
      showToast(t('userErrorForbidden', words), 'alert');
      await invalidateAll();
      return true;
    } else if (result.status === 404) showToast(t('userErrorNotFound', { name }), 'alert');
    else if (result.status === 0) showToast(t('userErrorUnreachable'), 'alert');
    else showToast(t('userUpdateFailed', { name }), 'alert');
    return false;
  }

  // 切り替えを押したとき（変わる前）。送っている間は変えない（aria-disabled は押すことを止めない）。
  // 自分の解除は、切り替えを外れた見た目にせず（既定の動きを止める）、確認のダイアログを経てから送る。
  // 無効でない管理者が自分だけなら、確認も出さずにその場で断る（API も 409 の last_admin で断る）
  function clickToggle(event: MouseEvent, user: User): void {
    if (busyId !== null) {
      event.preventDefault();
      return;
    }
    if (user.id !== meId || !user.is_admin) return;
    event.preventDefault();
    const input = event.currentTarget as HTMLInputElement;
    if (activeAdminCount <= 1) {
      showToast(t('userErrorLastAdmin', words), 'alert');
      return;
    }
    void (async () => {
      if (await confirmAction({ kind: 'revokeSelf', user }, input)) await sendAdmin(user, false, input);
    })();
  }

  // 切り替えが変わったとき（自分の解除のほか）
  function changeToggle(event: Event & { currentTarget: HTMLInputElement }, user: User): void {
    const input = event.currentTarget;
    if (busyId !== null || user.disabled_at !== null) {
      input.checked = user.is_admin;
      return;
    }
    void sendAdmin(user, input.checked, input);
  }

  async function sendAdmin(user: User, next: boolean, input: HTMLInputElement): Promise<void> {
    if (busyId !== null) return;
    const self = user.id === meId;
    const token = section.token();
    busyId = user.id;
    try {
      const result = await callOperation(userAdminUpdate, { user_id: user.id, is_admin: next }, { slug: currentSlug });
      if (!section.isCurrent(token)) return;
      if (result.ok) {
        applyState(result.data);
        showToast(t(next ? 'userDesignated' : 'userRevoked', { name: user.name, admin: t('admin') }), 'check');
        // 自分を解除したら、管理者の判定を読み直す（この画面は「見つからない」になる）。押した切り替えが消えるので、
        // 見出しへフォーカスを移す
        if (self && !next) {
          await invalidateAll();
          await tick();
          focusPageHeading();
          return;
        }
      } else {
        input.checked = user.is_admin;
        // 401 と 403 は画面を離れるので、一覧は読み直さない
        if (await reportFailure(result, user)) return;
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
    enableRefusal = null;
    const token = section.token();
    busyId = user.id;
    try {
      const result = disabling
        ? await callOperation(userDisable, { user_id: user.id }, { slug: currentSlug })
        : await callOperation(userEnable, { user_id: user.id }, { slug: currentSlug });
      if (!section.isCurrent(token)) return;
      if (result.ok) {
        applyState(result.data);
        showToast(
          disabling
            ? t('userDisabled', { name: user.name })
            : t('userEnabled', { name: user.name, workspace: t('workspace') }),
          'check',
        );
      } else {
        if (await reportFailure(result, user)) return;
      }
      await section.load();
    } finally {
      if (section.isCurrent(token)) busyId = null;
    }
    // 読み直しても行は残り、ボタンは文字だけを替える。押した行のボタンへフォーカスを戻す。
    // 理由のコールアウトを出したときは、フォーカスの移動で画面が押した行へ戻り、理由が画面の外に出ないよう、スクロールさせない
    await tick();
    document
      .querySelector<HTMLButtonElement>(`[data-user-action="${CSS.escape(user.id)}"]`)
      ?.focus({ preventScroll: enableRefusal !== null });
  }

  const status = $derived(busyId !== null ? t('userWorking') : '');
</script>

<Setting title={t('userSectionTitle')} description={t('userSectionDesc', words)}>
  <SectionBoundary {section} failedTitle={t('userListLoadFailed')} refreshFailedText={t('userListRefreshFailed')}>
    {#if enableRefusal !== null}
      <div class="callout is-warn" role="alert" bind:this={refusalBox}>
        <Icon name="alert" /><span class="wrap-anywhere">{enableRefusal}</span>
      </div>
    {/if}
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
                    aria-describedby={user.disabled_at !== null ? `${uid}-disabled-${user.id}` : undefined}
                    onclick={(event) => clickToggle(event, user)}
                    onchange={(event) => changeToggle(event, user)}
                  />
                </label>
                {#if user.disabled_at !== null}
                  <!-- 押せない理由。読み上げだけに出す（無効の印は名前の列にある） -->
                  <span class="visually-hidden" id={`${uid}-disabled-${user.id}`}
                    >{t('userAdminToggleDisabledNote', words)}</span
                  >
                {/if}
              </td>
              <td class="is-num" data-label={t('userWorkspaceCountHeader')}>{user.workspace_count}</td>
              <td class="mono" data-label={t('userLastSeenHeader')}>
                {#if user.last_seen_at === null}
                  <!-- 「—」は読み上げで意味を持たないので、見えない文字で添える -->
                  <span aria-hidden="true">{t('userNeverSeen')}</span><span class="visually-hidden"
                    >{t('userNeverSeenText')}</span
                  >
                {:else}
                  {formatLocalDate(user.last_seen_at)}
                {/if}
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
