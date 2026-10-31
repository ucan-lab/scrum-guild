<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { onMount } from 'svelte';
  import Gate from '../../lib/components/Gate.svelte';
  import GateSheet from '../../lib/components/GateSheet.svelte';
  import LogoutButton from '../../lib/components/LogoutButton.svelte';
  import { callOperation } from '../../lib/api.ts';
  import Icon from '../../lib/components/Icon.svelte';
  import { formatDateTime } from '../../lib/format-datetime.ts';
  import { isUnauthenticated, loginUrl } from '../../lib/login-redirect.ts';
  import { t } from '../../lib/vocabulary.svelte.ts';
  import type { OutputOf } from '../../shared/operations/define.ts';
  import { consentRecord, consentStatus } from '../../shared/operations/session/consent.ts';
  import { safeReturnTo } from '../../shared/return-to.ts';

  let status = $state<OutputOf<typeof consentStatus>>();
  let checked = $state(false);
  let busy = $state(false);
  let error = $state<'load' | 'record' | 'updated' | undefined>();
  const returnTo = $derived(safeReturnTo(page.url.searchParams.get('return_to')));

  async function loadStatus() {
    const result = await callOperation(consentStatus, {});
    if (isUnauthenticated(result)) {
      location.replace(loginUrl(page.url));
      return result;
    }
    if (result.ok) {
      status = result.data;
    } else {
      error = 'load';
    }
    return result;
  }

  async function submit(): Promise<void> {
    if (busy || !checked || status === undefined) return;
    busy = true;
    error = undefined;
    const result = await callOperation(consentRecord, {
      terms_version: status.terms_version,
      privacy_version: status.privacy_version,
    });
    if (result.ok) {
      location.replace(returnTo);
      return;
    }
    if (isUnauthenticated(result)) {
      location.replace(loginUrl(page.url));
      return;
    }
    if (result.status === 409) {
      checked = false;
      const reloaded = await loadStatus();
      if (reloaded.ok) error = 'updated';
    } else {
      error = 'record';
    }
    busy = false;
  }

  onMount(loadStatus);
</script>

<svelte:head>
  <title>{t('pageTitle', { page: t('consentTitle'), app: t('appName') })}</title>
</svelte:head>

<Gate>
  <GateSheet brand title={t('consentTitle')}>
    {#if error}
      <div class="callout is-warn" role="alert">
        <Icon name="alert" /><span
          >{error === 'load'
            ? t('consentLoadFailed')
            : error === 'record'
              ? t('consentRecordFailed')
              : t('consentUpdated')}</span
        >
      </div>
    {/if}
    {#if status === undefined}
      {#if error !== 'load'}<p role="status">{t('loading')}</p>{/if}
    {:else if status.current}
      <p>{t('consentCurrent')}</p>
      {#if status.latest}<p class="panel-note">
          {t('consentRecordedAt', { date: formatDateTime(status.latest.consented_at) })}
        </p>{/if}
      <div class="form-actions">
        <button class="btn is-primary" type="button" onclick={() => location.replace(returnTo)}
          >{t('consentContinue')}</button
        >
        <LogoutButton />
      </div>
    {:else}
      <p>{t('consentLead', { app: t('appName') })}</p>
      <div class="choice-list">
        <a class="choice" href={resolve('/terms')} target="_blank" rel="noopener noreferrer">
          <div>
            <b>{t('termsTitle')}</b><span class="mono">{t('consentVersion', { version: status.terms_version })}</span>
          </div>
        </a>
        <a class="choice" href={resolve('/privacy')} target="_blank" rel="noopener noreferrer">
          <div>
            <b>{t('privacyTitle')}</b><span class="mono"
              >{t('consentVersion', { version: status.privacy_version })}</span
            >
          </div>
        </a>
      </div>
      <label class="choice is-static">
        <input type="checkbox" bind:checked />
        <span>{t('consentCheckLabel')}</span>
      </label>
      <div class="form-actions">
        <button class="btn is-primary" type="button" aria-disabled={!checked || busy} onclick={submit}>
          {busy ? t('consentSubmitting') : t('consentSubmit')}
        </button>
        <LogoutButton />
      </div>
    {/if}
  </GateSheet>
</Gate>
