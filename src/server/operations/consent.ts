import { PRIVACY_VERSION, TERMS_VERSION } from '../../lib/legal/versions.ts';
import { consentRecord, consentStatus } from '../../shared/operations/session/consent.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';

export const consentStatusOperation = implement(consentStatus, async ({ db, accountId }) => {
  const latest = await db.first(
    db.statement((q) =>
      q
        .selectFrom('account_consents')
        .select(['terms_version', 'privacy_version', 'consented_at'])
        .where('account_id', '=', accountId)
        .orderBy('consented_at', 'desc')
        .limit(1),
    ),
  );
  return {
    terms_version: TERMS_VERSION,
    privacy_version: PRIVACY_VERSION,
    latest: latest ?? null,
    current: latest?.terms_version === TERMS_VERSION && latest.privacy_version === PRIVACY_VERSION,
  };
});

export const consentRecordOperation = implement(consentRecord, async ({ db, accountId, input }) => {
  if (input.terms_version !== TERMS_VERSION || input.privacy_version !== PRIVACY_VERSION) {
    throw new ApiError(409, 'conflict');
  }
  const latest = await db.first(
    db.statement((q) =>
      q
        .selectFrom('account_consents')
        .select(['terms_version', 'privacy_version'])
        .where('account_id', '=', accountId)
        .orderBy('consented_at', 'desc')
        .limit(1),
    ),
  );
  if (latest?.terms_version === TERMS_VERSION && latest.privacy_version === PRIVACY_VERSION) return {};
  await db.batch([
    db.statement((q) =>
      q.insertInto('account_consents').values({
        account_id: accountId,
        terms_version: input.terms_version,
        privacy_version: input.privacy_version,
        consented_at: new Date().toISOString(),
      }),
    ),
  ]);
  return {};
});
