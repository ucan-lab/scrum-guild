<script lang="ts">
  import { tick } from 'svelte';
  import { page } from '$app/state';
  import { callOperation } from '../api.ts';
  import { isUnauthenticated, loginUrl } from '../login-redirect.ts';
  import { t } from '../vocabulary.svelte.ts';
  import { slugProblem } from '../../shared/organization-slug.ts';
  import {
    createMyOrganization,
    createMyOrganizationConflictReasonOf,
  } from '../../shared/operations/organization/index.ts';
  import type { DictionaryKey } from '../../shared/vocabulary.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';

  let { open = $bindable(false) }: { open?: boolean } = $props();
  let dialog = $state<ReturnType<typeof Dialog>>();
  let slug = $state('');
  let name = $state('');
  let busy = $state(false);
  let error = $state<{ field: 'slug' | 'name' | 'form'; key: DictionaryKey } | null>(null);
  let slugInput = $state<HTMLInputElement>();

  export function show(trigger?: HTMLElement | null): void {
    dialog?.show(trigger);
  }

  function reset(): void {
    slug = '';
    name = '';
    error = null;
    busy = false;
  }

  $effect(() => {
    void open;
    reset();
  });

  function validate(): boolean {
    const problem = slugProblem(slug);
    if (problem !== undefined) {
      error = {
        field: 'slug',
        key: problem === 'format' ? 'createMyOrganizationSlugFormat' : 'createMyOrganizationSlugReserved',
      };
      return false;
    }
    if (name.trim() === '') {
      error = { field: 'name', key: 'createMyOrganizationNameRequired' };
      return false;
    }
    error = null;
    return true;
  }

  async function submit(): Promise<void> {
    if (busy || !validate()) {
      await tick();
      (error?.field === 'slug'
        ? slugInput
        : document.querySelector<HTMLInputElement>('#create-my-organization-name')
      )?.focus();
      return;
    }
    busy = true;
    const result = await callOperation(createMyOrganization, { slug, name });
    if (result.ok) {
      window.location.assign(`/${result.data.slug}`);
      return;
    }
    busy = false;
    if (isUnauthenticated(result)) {
      window.location.assign(loginUrl(page.url));
      return;
    }
    const reason = createMyOrganizationConflictReasonOf(result.error?.details);
    const failure =
      reason === 'slug_taken'
        ? { field: 'slug' as const, key: 'createMyOrganizationSlugTaken' as const }
        : reason === 'trial_limit'
          ? { field: 'form' as const, key: 'createMyOrganizationTrialLimit' as const }
          : result.status === 400
            ? { field: 'form' as const, key: 'createMyOrganizationInvalid' as const }
            : { field: 'form' as const, key: 'createMyOrganizationFailed' as const };
    error = failure;
    await tick();
    (failure.field === 'slug' ? slugInput : document.querySelector<HTMLElement>('[role="alert"]'))?.focus();
  }
</script>

<Dialog bind:this={dialog} bind:open dismissible={!busy} title={t('createMyOrganizationTitle')}>
  <p>{t('createMyOrganizationLead')}</p>
  <div class="field" class:is-invalid={error?.field === 'slug'}>
    <label class="field-label" for="create-my-organization-slug">{t('createMyOrganizationSlugLabel')}</label>
    <input
      bind:this={slugInput}
      class="input mono"
      id="create-my-organization-slug"
      bind:value={slug}
      autocomplete="off"
      spellcheck="false"
      aria-invalid={error?.field === 'slug' ? 'true' : undefined}
      aria-describedby={error?.field === 'slug' ? 'create-my-organization-slug-error' : undefined}
      readonly={busy}
      oninput={() => (error = null)}
    />
    {#if error?.field === 'slug'}<span
        class="field-error"
        id="create-my-organization-slug-error"
        role="alert"
        tabindex="-1"><Icon name="alert" />{t(error.key)}</span
      >{/if}
  </div>
  <div class="field" class:is-invalid={error?.field === 'name'}>
    <label class="field-label" for="create-my-organization-name">{t('createMyOrganizationNameLabel')}</label>
    <input
      class="input"
      id="create-my-organization-name"
      bind:value={name}
      autocomplete="organization"
      readonly={busy}
      aria-invalid={error?.field === 'name' ? 'true' : undefined}
      aria-describedby={error?.field === 'name' ? 'create-my-organization-name-error' : undefined}
      oninput={() => (error = null)}
    />
    {#if error?.field === 'name'}<span class="field-error" id="create-my-organization-name-error" role="alert"
        ><Icon name="alert" />{t(error.key)}</span
      >{/if}
  </div>
  {#if error?.field === 'form'}<div class="callout is-warn" role="alert" tabindex="-1">
      <Icon name="alert" /><span>{t(error.key)}</span>
    </div>{/if}
  {#snippet footer(close)}
    <button class="btn is-primary" type="button" aria-disabled={busy} onclick={() => void submit()}
      >{busy ? t('createMyOrganizationSubmitting') : t('createMyOrganizationSubmit')}</button
    >
    <button class="btn is-sm is-quiet" type="button" aria-disabled={busy} onclick={close}>{t('cancel')}</button>
  {/snippet}
</Dialog>
