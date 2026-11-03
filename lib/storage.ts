import type { Env } from './runtime/config';
export interface Subscription {
  id:string; owner:string; name:string; args:string; conversation:string; thread:string|null;
  callback:string; secret:string|null; secret_hash:string; verified_at:number; created_at:number; expires_at:number; active:number;
  previous_secret:string|null; previous_secret_expires_at:number|null;
}
// Opportunistic and bounded: expiry is always enforced on reads, even when cleanup
// has more stale rows to remove or there has been no traffic since expiration.
export async function cleanup(env: Env, now: number) {
  await env.DB.prepare('DELETE FROM subscriptions WHERE id IN (SELECT id FROM subscriptions WHERE expires_at<=? OR active=0 LIMIT 100)').bind(now).run();
  await env.DB.prepare(`UPDATE subscriptions SET previous_secret=NULL,previous_secret_expires_at=NULL WHERE id IN
    (SELECT id FROM subscriptions WHERE previous_secret IS NOT NULL AND (previous_secret_expires_at IS NULL OR previous_secret_expires_at<=?) LIMIT 100)`).bind(now).run();
}
