import { PRIVACY_VERSION, TERMS_VERSION } from '../../lib/legal/versions.ts';
import { consentRecord, consentStatus } from '../../shared/operations/session/consent.ts';
import type { CommonDb } from '../db/index.ts';
import { ApiError } from '../errors.ts';
import { implement } from './implement.ts';

// 同じ時刻（ミリ秒）の行が並んでも結果が決まるよう、版でも並べる
async function latestConsentOf(db: CommonDb, accountId: string) {
  return db.first(
    db.statement((q) =>
      q
        .selectFrom('account_consents')
        .select(['terms_version', 'privacy_version', 'consented_at'])
        .where('account_id', '=', accountId)
        .orderBy('consented_at', 'desc')
        .orderBy('terms_version', 'desc')
        .orderBy('privacy_version', 'desc')
        .limit(1),
    ),
  );
}

export const consentStatusOperation = implement(consentStatus, async ({ db, accountId }) => {
  const latest = await latestConsentOf(db, accountId);
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
  // 最新の同意が今の2つの版と一致するかの確かめと INSERT を1文にする。読んでから書くと、同時の送信が揃って行を足し、
  // 同じミリ秒なら主キーに当たって 500 になる
  const consentedAt = new Date().toISOString();
  await db.batch([
    db.statement((q) =>
      q
        .insertInto('account_consents')
        .columns(['account_id', 'terms_version', 'privacy_version', 'consented_at'])
        .expression(
          q
            .selectNoFrom((eb) => [
              eb.val(accountId).as('account_id'),
              eb.val(TERMS_VERSION).as('terms_version'),
              eb.val(PRIVACY_VERSION).as('privacy_version'),
              eb.val(consentedAt).as('consented_at'),
            ])
            .where((eb) =>
              eb.not(
                eb.exists(
                  eb
                    .selectFrom('account_consents')
                    .select('account_id')
                    .where('account_id', '=', accountId)
                    .where('terms_version', '=', TERMS_VERSION)
                    .where('privacy_version', '=', PRIVACY_VERSION)
                    .where(
                      'consented_at',
                      '=',
                      eb
                        .selectFrom('account_consents')
                        .select((max) => max.fn.max<string>('consented_at').as('latest'))
                        .where('account_id', '=', accountId),
                    ),
                ),
              ),
            ),
        ),
    ),
  ]);
  return {};
});
