<script lang="ts">
  import { logoutState, performLogout } from '../logout-action.svelte.ts';
  import { t } from '../vocabulary.svelte.ts';

  // 組織の外の画面（/、/operator）の紙の一番下に置く、静かなログアウトのボタン。
  // 組織の中は AccountMenu の項目から同じ performLogout を呼ぶ。押した後は、結果が返るまでボタンを止めて文言を替える。
  // disabled にしないのは、失敗して戻したときにフォーカスが外れないようにするため（見本の .btn[aria-disabled] と同じ）。
  // 待っている間は、常に置く読み上げの領域にも伝える（文字だけを替える。OrganizationSwitcher と同じ）
</script>

<button class="btn is-sm is-quiet" type="button" aria-disabled={logoutState.busy} onclick={performLogout}>
  {logoutState.busy ? t('logoutMoving') : t('logout')}
</button>
<span class="visually-hidden" role="status">{logoutState.busy ? t('logoutMoving') : ''}</span>
