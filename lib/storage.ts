import type { Env } from './runtime/config';
export interface Subscription {
  id:string; owner:string; name:string; args:string; conversation:string; thread:string|null;
  callback:string; secret:string|null; secret_hash:string; verified_at:number; created_at:number; expires_at:number; active:number;
}
// Opportunistic and bounded: expiry is always enforced on reads, even when cleanup
// has more stale rows to remove or there has been no traffic since expiration.
export async function cleanup(env: Env, now: number) {
  await env.DB.prepare('DELETE FROM subscriptions WHERE id IN (SELECT id FROM subscriptions WHERE expires_at<=? OR active=0 LIMIT 100)').bind(now).run();
}
