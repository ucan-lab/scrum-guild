// 招待の URL の秘密（docs/data-model.md の「メールアドレスで待つ指名と招待」）。運用者の Google の指名（operator-nominee.ts）と、
// ワークスペースの Google の招待（invitation.ts）が同じ作り方を使う。
// 秘密（claimToken）は応答の本文にだけ入れ、DB には SHA-256（claimTokenHash）だけを持つ。期限は作ってから14日
import { CLAIM_LIFETIME_DAYS } from '../../shared/claim-token.ts';
import { randomToken, sha256Hex } from '../auth/tokens.ts';

export type ClaimSecret = { claimToken: string; claimTokenHash: string; claimExpiresAt: string };

export async function newClaimSecret(now: Date): Promise<ClaimSecret> {
  const claimToken = randomToken();
  const claimExpiresAt = new Date(now.getTime() + CLAIM_LIFETIME_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return { claimToken, claimTokenHash: await sha256Hex(claimToken), claimExpiresAt };
}
