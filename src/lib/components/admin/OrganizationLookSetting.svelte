<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { organizationSettingsUpdate } from '../../../shared/operations/organization/index.ts';
  import { themeLabelKeys, themeNoteKeys, themes, type Theme } from '../../../shared/theme.ts';
  import { callOperation } from '../../api.ts';
  import { isUnauthenticated, loginUrl } from '../../login-redirect.ts';
  import { showToast } from '../../toast.svelte.ts';
  import { t } from '../../vocabulary.svelte.ts';
  import Icon from '../Icon.svelte';
  import Setting from '../Setting.svelte';

  // 組織の管理の画面（admin.html）の「既定のテーマ」の節。
  // 値は組織の枠が読んだ値（organization 操作の結果）を受け取り、節は自分で読まない。
  // 選ぶことと確定することを分ける（矢印のキーでラジオを動かすたびに、組織の全員の既定を変えない）。「保存する」は、
  // 選んだ値が今の値と違うときだけ押せる。送っている間はそのボタンを aria-disabled にして押しても無視し、ラジオは選べたままにする
  // （結果は送った値で判断する）。通ったら知らせを出し、組織の枠を読み直して自分の画面にも当てる（テーマは自分で選んでいなければ変わる）。
  // 409（ほかの管理者が先に変えた）と 403、404 は知らせて読み直し、今の値を見せる。401 はログインへ。
  // ほかの失敗（通信、5xx）は選んだ値を残して知らせ、そのまま押し直せる。
  // 失敗の知らせは、トーストでなく節の中（role="alert"）に、次に選ぶか押すまで残す（消えると、失敗したのか未操作なのか分からない）
  let { slug, theme }: { slug: string; theme: Theme } = $props();

  const ids = $props.id();
  // 選んだがまだ保存していない値。null は選んでいない（今の値を見せる）
  let draft = $state<Theme | null>(null);
  // 送っている値
  let sending = $state<Theme | null>(null);
  // 失敗の知らせ。次に選ぶか押すまで残す
  let error = $state<string | null>(null);

  const chosen = $derived(draft ?? theme);
  const canSave = $derived(sending === null && chosen !== theme);

  // slug が替わったら、前の組織で選んだ値を捨てる
  $effect(() => {
    void slug;
    draft = null;
    error = null;
  });

  function choose(value: Theme): void {
    draft = value;
    error = null;
  }

  async function save(): Promise<void> {
    if (!canSave) return;
    const sentSlug = slug;
    const value = chosen;
    // 見ていた値（from）も送る。ほかの管理者が先に変えていれば 409 になり、気づかずに上書きしない
    const change = { theme: { from: theme, to: value } };
    const success = t('orgThemeChanged', { label: t(themeLabelKeys[value]) });
    sending = value;
    error = null;
    try {
      const result = await callOperation(organizationSettingsUpdate, change, { slug: sentSlug });
      if (sentSlug !== slug) return;
      if (isUnauthenticated(result)) {
        window.location.assign(loginUrl(page.url));
        return;
      }
      if (result.ok) {
        showToast(success, 'check');
      } else if (result.status === 409 && result.error?.code === 'conflict') {
        error = t('orgSettingsConflict', { admin: t('admin') });
      } else if (result.status === 403 || result.status === 404) {
        error = t('orgSettingsUnavailable');
      } else {
        // 選んだ値は残し、そのまま押し直せる
        error = t('orgSettingsFailed');
        return;
      }
      await invalidateAll();
      // 送った値のままなら、選んだ値を捨てて読み直した組織の枠の値を見せる。送っている間に選び直していれば残す
      if (sentSlug === slug && draft === value) draft = null;
    } finally {
      sending = null;
    }
  }

  const status = $derived(sending !== null ? t('orgSettingsSaving') : '');
</script>

<Setting title={t('orgThemeTitle')} description={t('orgThemeDesc')}>
  <div class="choice-list" role="radiogroup" aria-label={t('orgThemeTitle')}>
    {#each themes as value (value)}
      <label class="choice">
        <input type="radio" name="{ids}-theme" {value} checked={chosen === value} onchange={() => choose(value)} />
        <div><b>{t(themeLabelKeys[value])}</b><span>{t(themeNoteKeys[value])}</span></div>
      </label>
    {/each}
  </div>
  <div class="form-actions">
    <button class="btn" type="button" aria-disabled={!canSave} onclick={save}>
      {sending !== null ? t('orgSettingsSaving') : t('orgSettingsSave')}
    </button>
  </div>
  <!-- 失敗の知らせ。領域は常に置き、中の文字だけを替える -->
  <div role="alert">
    {#if error !== null}<span class="field-error"><Icon name="alert" />{error}</span>{/if}
  </div>
  <!-- 送っている間の読み上げ。領域は常に置き、中の文字だけを替える -->
  <span class="visually-hidden" role="status">{status}</span>
</Setting>
