<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { t } from '../vocabulary.svelte.ts';

  // kit.js の組織の切り替え。選ぶとその組織へ移り、最後の項目は組織の選択の画面へ戻る
  let {
    organizations,
    currentSlug,
  }: { organizations: readonly { slug: string; name: string }[]; currentSlug: string } = $props();

  const id = $props.id();
  // slug は英小文字・数字・ハイフンなので、空の値は一覧の項目だけを指す
  const LIST = '';

  function change(event: Event & { currentTarget: HTMLSelectElement }): void {
    const value = event.currentTarget.value;
    void goto(value === LIST ? resolve('/') : resolve('/[slug]', { slug: value }));
  }
</script>

<label class="ws-select" for={id}>
  <span>{t('organization')}</span>
  <select {id} onchange={change}>
    {#each organizations as organization (organization.slug)}
      <option value={organization.slug} selected={organization.slug === currentSlug}>{organization.name}</option>
    {/each}
    <option value={LIST}>{t('organizationList')}</option>
  </select>
</label>
