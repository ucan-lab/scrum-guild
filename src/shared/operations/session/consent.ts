import { z } from 'zod';
import { LEGAL_VERSION_PATTERN } from '../../../lib/legal/versions.ts';
import { defineOperation } from '../define.ts';

const legalVersion = z.string().regex(LEGAL_VERSION_PATTERN);

export const consentStatus = defineOperation({
  name: 'consent-status',
  description: '現在の利用規約とプライバシーポリシーの版と、自分の最新の同意を返す',
  mode: 'read',
  permission: 'login',
  // 同意していない人が、今の版と自分の状態を読めるように
  skipsConsent: true,
  input: z.object({}),
  output: z.object({
    terms_version: z.string(),
    privacy_version: z.string(),
    latest: z.object({ terms_version: z.string(), privacy_version: z.string(), consented_at: z.string() }).nullable(),
    current: z.boolean(),
  }),
});

export const consentRecord = defineOperation({
  name: 'consent-record',
  description: '現在の利用規約とプライバシーポリシーへの同意を記録する',
  mode: 'write',
  permission: 'login',
  cookieOnly: true,
  // 同意するための操作なので、同意していない人も呼べる
  skipsConsent: true,
  rateLimit: { max: 30, windowSeconds: 600 },
  input: z.object({ terms_version: legalVersion, privacy_version: legalVersion }),
  output: z.object({}),
});
