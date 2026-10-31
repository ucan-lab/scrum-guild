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
      // 読み直せなければ、古い版のフォームを残さず、読み込み失敗の画面（もう一度試す）に入れる
      if (!reloaded.ok) status = undefined;
      // 別のタブで同意済みなら、読み直した画面が同意済みを出すので、更新の知らせは添えない
      else if (!reloaded.data.current) error = 'updated';
    } else {
      error = 'record';
    }
    busy = false;
  }

  async function retryLoad(): Promise<void> {
    if (busy) return;
    busy = true;
    // 読み直している間も、押したボタンとログアウトを残す（外すとフォーカスが失われ、出口も消える）。成功したときだけ警告を消す
    const result = await loadStatus();
    if (result.ok) error = undefined;
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
      {#if error === 'load'}
        <div class="form-actions">
          <button class="btn is-sm" type="button" aria-disabled={busy} onclick={retryLoad}>{t('retry')}</button>
          <LogoutButton />
          <span class="field-hint" role="status">{busy ? t('retrying') : ''}</span>
        </div>
      {:else}
        <p role="status">{t('loading')}</p>
      {/if}
    {:else if status.current}
      <p>{t('consentCurrent')}</p>
      {#if status.latest}<p class="panel-note">
          {t('consentRecordedAt')} <span class="mono">{formatDateTime(status.latest.consented_at)}</span>
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
          <span class="visually-hidden"> {t('markdownNewTab')}</span>
        </a>
        <a class="choice" href={resolve('/privacy')} target="_blank" rel="noopener noreferrer">
          <div>
            <b>{t('privacyTitle')}</b><span class="mono"
              >{t('consentVersion', { version: status.privacy_version })}</span
            >
          </div>
          <span class="visually-hidden"> {t('markdownNewTab')}</span>
        </a>
      </div>
      <label class="choice is-static is-consent">
        <input type="checkbox" bind:checked />
        <span>{t('consentCheckLabel')}</span>
      </label>
      <div class="form-actions">
        <button
          class="btn is-primary"
          type="button"
          aria-disabled={!checked || busy}
          aria-describedby={checked ? undefined : 'consent-submit-hint'}
          onclick={submit}
        >
          {busy ? t('consentSubmitting') : t('consentSubmit')}
        </button>
        <LogoutButton />
      </div>
      <span class="field-hint is-reserved" id="consent-submit-hint" aria-hidden={checked}>{t('consentSubmitHint')}</span
      >
    {/if}
  </GateSheet>
</Gate>
