import { z } from 'zod';
import { filterSchema } from '../slack/normalize';
import { Failure, requireConfig, type Env } from '../runtime/config';
import { canonical, encrypt, hash } from '../runtime/crypto';
import { cleanup, type Subscription } from '../storage';
import { CallbackClient, validateSecret } from './callback';

const SUBSCRIPTION_LIFETIME_MS = 72 * 60 * 60 * 1000;

export const subscribeSchema=z.object({name:z.literal('slack.message.created'), arguments:filterSchema,
  delivery:z.object({mode:z.literal('webhook'),url:z.string().url().max(2048),secret:z.string().max(100)}).strict(),
  cursor:z.null().optional(), ttlMs:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  _meta:z.record(z.string(),z.unknown()).optional()}).strict();
const unsubscribeSchema=z.union([
  z.object({name:z.literal('slack.message.created'),arguments:filterSchema,
    delivery:z.object({mode:z.literal('webhook'),url:z.string().url().max(2048)}).strict(),
    _meta:z.record(z.string(),z.unknown()).optional()}).strict(),
  // Preserve the prototype's ID form for existing callers.
  z.object({id:z.string().max(100),_meta:z.record(z.string(),z.unknown()).optional()}).strict(),
]);
function subscriptionId(principal:string,url:string,name:string,args:unknown) {
  return `sub_${hash(canonical({principal,url,name,arguments:args}))}`;
}
export async function subscribe(env: Env, principal: string, value: unknown, access:(id:string)=>Promise<void>, callback=new CallbackClient(env.CALLBACK_ALLOWED_ORIGINS), now=Date.now()) {
  requireConfig(env,['DB','SUBSCRIPTION_ENCRYPTION_KEY']);
  const input=subscribeSchema.parse(value);
  await access(input.arguments.conversation_id);
  validateSecret(input.delivery.secret);
  const url=callback.validate(input.delivery.url), args=canonical(input.arguments);
  const id=subscriptionId(principal,url,input.name,input.arguments);
  const secretHash=hash(input.delivery.secret);
  await cleanup(env,now);
  const existing=await env.DB.prepare('SELECT * FROM subscriptions WHERE id=? AND owner=?').bind(id,principal).first<Subscription>();
  // Secret rotation and reactivation always reverify; successful refreshes cache for five minutes.
  if (!existing?.active || existing.expires_at<=now || existing.secret_hash!==secretHash || existing.verified_at<now-300000) {
    try { await callback.verify(url,input.delivery.secret,id); }
    catch(e) { throw new Failure(e instanceof Failure ? e.category : 'challenge_failed'); }
  }
  // A null/no-expiration request still receives our finite maximum lifetime.
  const expires=now+Math.min(input.ttlMs ?? SUBSCRIPTION_LIFETIME_MS,SUBSCRIPTION_LIFETIME_MS);
  const secret=await encrypt(input.delivery.secret,env.SUBSCRIPTION_ENCRYPTION_KEY,id);
  await env.DB.prepare(`INSERT INTO subscriptions(id,owner,name,args,conversation,thread,callback,secret,secret_hash,verified_at,created_at,expires_at,active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,secret_hash=excluded.secret_hash,
    verified_at=excluded.verified_at,expires_at=excluded.expires_at,active=1,
    created_at=CASE WHEN subscriptions.active=0 OR subscriptions.expires_at<=? THEN excluded.created_at ELSE subscriptions.created_at END`)
    .bind(id,principal,input.name,args,input.arguments.conversation_id,input.arguments.thread_ts??null,url,secret,secretHash,
      existing?.active && existing.expires_at>now && existing.secret_hash===secretHash && existing.verified_at>=now-300000 ? existing.verified_at : now,now,expires,now).run();
  return {id,refreshBefore:new Date(expires).toISOString(),cursor:null,truncated:false};
}
export async function unsubscribe(env: Env, principal: string, value: unknown, now=Date.now()) {
  const input=unsubscribeSchema.parse(value);
  // Canonicalize without network access or requiring a still-configured callback allowlist.
  const id='id' in input ? input.id : subscriptionId(principal,new URL(input.delivery.url).href,input.name,input.arguments);
  await env.DB.prepare('DELETE FROM subscriptions WHERE id=? AND owner=?').bind(id,principal).run();
  await cleanup(env,now);
  return {};
}
