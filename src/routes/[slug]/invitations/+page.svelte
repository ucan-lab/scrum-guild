<script lang="ts">
  import InvitationInbox from '../../../lib/components/InvitationInbox.svelte';
  import LoadFailed from '../../../lib/components/LoadFailed.svelte';
  import type { PageProps } from './$types';

  // 招待の画面。組織の枠はこのページで枠を出さないので、紙だけの画面になる（InvitationInbox）。
  // member は組織に入れる人か（組織の枠が organization の操作の結果を持つ）
  let { data }: PageProps = $props();
</script>

{#if data.invitationPage.list}
  <InvitationInbox slug={data.slug} list={data.invitationPage.list} member={data.organization !== null} />
{:else}
  <LoadFailed />
{/if}
