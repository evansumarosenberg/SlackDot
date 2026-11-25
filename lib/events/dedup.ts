import { createHmac, randomUUID } from 'node:crypto';
import type { Env } from '../runtime/config';

export const DEDUP_MS = 3 * 60 * 60 * 1000;
export const CLAIM_MS = 45_000;
export interface Claim { key:string; token:string }

export function deliveryKey(env:Env,eventId:string,subscriptionId:string) {
  return createHmac('sha256',Buffer.from(env.SUBSCRIPTION_ENCRYPTION_KEY,'base64'))
    .update(JSON.stringify(['slackdot-event-dedup-v1',eventId,subscriptionId])).digest('hex');
}

// One atomic statement arbitrates simultaneous ingress and abandoned claims.
// Reclaims preserve the original expiry; duplicates never slide the window.
// Require room for a full claim so cleanup cannot remove a live worker's claim
// and admit a new worker at the fixed retention boundary.
export async function claimDelivery(env:Env,eventId:string,subscriptionId:string,now:number):Promise<Claim|null> {
  const key=deliveryKey(env,eventId,subscriptionId),token=randomUUID();
  const row=await env.DB.prepare(`INSERT INTO event_dedup(key,state,claim_token,claim_expires_at,expires_at)
    VALUES (?,'processing',?,?,?) ON CONFLICT(key) DO UPDATE SET
    state='processing',claim_token=excluded.claim_token,claim_expires_at=excluded.claim_expires_at,
    expires_at=CASE WHEN event_dedup.expires_at<=? THEN excluded.expires_at ELSE event_dedup.expires_at END
    WHERE event_dedup.expires_at<=? OR (event_dedup.state!='delivered' AND event_dedup.claim_expires_at<=? AND event_dedup.expires_at>=?)
    RETURNING claim_token`).bind(key,token,now+CLAIM_MS,now+DEDUP_MS,now,now,now,now+CLAIM_MS).first<{claim_token:string}>();
  return row?.claim_token===token ? {key,token} : null;
}

export async function ownsClaim(env:Env,claim:Claim,now:number) {
  return !!await env.DB.prepare(`SELECT key FROM event_dedup WHERE key=? AND claim_token=?
    AND state='processing' AND claim_expires_at>? AND expires_at>?`)
    .bind(claim.key,claim.token,now,now).first();
}

export async function finishDelivery(env:Env,claim:Claim,state:'delivered'|'failed',now:number) {
  // A stale invocation cannot finish a newer claim. Failed attempts keep the
  // original 45-second cooldown; only fresh ingress can try again afterward.
  await env.DB.prepare(`UPDATE event_dedup SET state=?,claim_token=NULL WHERE key=? AND claim_token=?
    AND state='processing' AND claim_expires_at>? AND expires_at>?`)
    .bind(state,claim.key,claim.token,now,now).run();
}
