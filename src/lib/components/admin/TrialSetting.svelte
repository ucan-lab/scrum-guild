<script lang="ts">
  import { t } from '../../vocabulary.svelte.ts';
  import Setting from '../Setting.svelte';

  let { trial }: { trial: { ends_on: string; days_left: number } } = $props();
</script>

<Setting title={t('orgTrialTitle')} description={t('orgTrialDesc')}>
  <p class="mono">{t('orgTrialEndsOn', { date: trial.ends_on })}</p>
  <p class="props-note">{t('orgTrialDaysLeft', { days: trial.days_left })}</p>
</Setting>
