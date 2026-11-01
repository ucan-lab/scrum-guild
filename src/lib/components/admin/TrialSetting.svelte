<script lang="ts">
  import { t } from '../../vocabulary.svelte.ts';
  import Icon from '../Icon.svelte';
  import Setting from '../Setting.svelte';

  let { trial }: { trial: { ends_on: string; days_left: number } } = $props();
</script>

<Setting title={t('orgTrialTitle')} description={t('orgTrialDesc')}>
  <p class="mono">{t('orgTrialEndsOn', { date: trial.ends_on })}</p>
  {#if trial.days_left < 0}
    <p><span class="chip is-danger"><Icon name="alert" />{t('orgTrialExpired')}</span></p>
  {:else if trial.days_left === 0}
    <p class="props-note">{t('orgTrialLastDay')}</p>
  {:else}
    <p class="props-note">{t('orgTrialDaysLeft', { days: trial.days_left })}</p>
  {/if}
</Setting>
