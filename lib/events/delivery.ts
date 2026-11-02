import { Failure, type Env } from '../runtime/config';
import { decrypt } from '../runtime/crypto';
import { cleanup, type Subscription } from '../storage';
import { CallbackClient } from './callback';
import type { MessageEvent } from '../slack/normalize';
interface Job {event_id:string;subscription_id:string;attempts:number;deadline:number;claim:string}
export async function drain(env: Env, access:(id:string)=>Promise<void>, callbacks=new CallbackClient(env.CALLBACK_ALLOWED_ORIGINS), clock=Date.now) {
  const start=clock(); let processed=0;
  // Bound one scheduler invocation. Every row has a lease so a later invocation can recover it.
  while (processed<10 && clock()-start<20000) {
    const now=clock(), claim=crypto.randomUUID();
    const job=await env.DB.prepare(`UPDATE deliveries SET state='claimed',claim=?,lease_until=?,attempts=attempts+1
      WHERE rowid=(SELECT rowid FROM deliveries WHERE (state='pending' AND next_at<=?) OR (state='claimed' AND lease_until<=?) ORDER BY next_at LIMIT 1)
      RETURNING event_id,subscription_id,attempts,deadline,claim`).bind(claim,now+60000,now,now).first<Job>();
    if (!job) break;
    processed++;
    const finish=async(state:string,reason:string|null,next=now) => {
      await env.DB.prepare('UPDATE deliveries SET state=?,last_error=?,next_at=?,claim=NULL,lease_until=NULL WHERE event_id=? AND subscription_id=? AND claim=?')
        .bind(state,reason,next,job.event_id,job.subscription_id,claim).run();
    };
    const current=()=>env.DB.prepare('SELECT * FROM subscriptions WHERE id=?').bind(job.subscription_id).first<Subscription>();
    let sub=await current();
    if (!sub?.active || sub.owner!==env.OWNER_USER_ID || sub.expires_at<=now || !sub.secret) { await finish('cancelled','inactive_subscription'); continue; }
    if (now>=job.deadline || job.attempts>8) { await finish('terminal','retry_exhausted'); continue; }
    try {
      await access(sub.conversation);
      // Re-read after network authorization so unsubscribe/rotation is observed immediately before send.
      sub=await current();
      const activeClaim=await env.DB.prepare("SELECT claim FROM deliveries WHERE event_id=? AND subscription_id=? AND state='claimed'").bind(job.event_id,job.subscription_id).first<{claim:string}>();
      if (!sub?.active || sub.owner!==env.OWNER_USER_ID || sub.expires_at<=clock() || !sub.secret || activeClaim?.claim!==claim) { await finish('cancelled','inactive_subscription'); continue; }
      const stored=await env.DB.prepare('SELECT payload FROM events WHERE id=?').bind(job.event_id).first<{payload:string}>();
      if (!stored) { await finish('terminal','event_missing'); continue; }
      const event=JSON.parse(stored.payload) as MessageEvent;
      const secret=await decrypt(sub.secret,env.SUBSCRIPTION_ENCRYPTION_KEY,sub.id);
      const response=await callbacks.post(sub.callback,secret,sub.id,event.eventId,stored.payload,clock());
      const status=response.status;
      const retryAfter=Number(response.headers.get('retry-after')) || 0;
      await response.body?.cancel();
      if (response.ok) { await finish('delivered',null); continue; }
      if (status===410 || status===413 || (status>=400 && status<500 && status!==429 && status!==408)) { await finish('terminal',`http_${status}`); continue; }
      throw new Failure('callback_transient',Math.min(retryAfter,3600));
    } catch(e) {
      const category=e instanceof Failure ? e.category : 'delivery_failed';
      if (['installation_revoked','installation_mismatch','conversation_unavailable','missing_scope'].includes(category)) {
        await env.DB.prepare('UPDATE subscriptions SET active=0,secret=NULL WHERE id=?').bind(job.subscription_id).run();
        await finish('cancelled',category); continue;
      }
      if (category.startsWith('callback_destination') || category==='callback_redirect_blocked' || category==='payload_too_large') { await finish('terminal',category); continue; }
      const delay=Math.max(60000*2**(job.attempts-1),e instanceof Failure ? (e.retryAfter??0)*1000 : 0);
      await finish(job.attempts>=8 ? 'terminal' : 'pending',category,clock()+Math.min(delay,3600000));
    }
  }
  await cleanup(env,clock());
  return {processed};
}
